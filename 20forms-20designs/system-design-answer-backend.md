# Form Library Comparison — Backend and Infrastructure System Design

*A 45-minute interview discussion. This application has no dynamic backend; the
backend focus is building and delivering a reliable static product. These are
proposed choices. See [architecture.md](./architecture.md) for the actual source.*

## 🎯 Establish the workload — 5 minutes

> “Before adding services, I would establish what happens at request time. Users
> compare interactive examples, but the examples do not submit business data.
> We can build the applications ahead of time and serve static files. The harder
> backend problems are producing a consistent release and delivering it reliably.”

I would clarify whether we need accounts, saved comparisons across devices, private
examples, or user-uploaded code. Each would introduce requirements beyond the static
showcase. For this discussion, examples are curated and comparisons are shared as
URLs, with optional preferences stored in the browser.

Assume roughly fifty component-library entries and twenty form types. Each library
has an independently built React application that can render any of those forms.
A shell displays selected examples in isolated iframe documents.

A thousand possible comparisons does not require a thousand backend services or a
thousand distinct builds. We can build once per library while allowing the browser
to instantiate different form selections from the same library artifact.

### Requirements I would write down

| Requirement | Implication |
|-------------|-------------|
| Public static examples | No application server or database on the read path |
| Native library behavior | Independent builds and document boundaries |
| Repeatable releases | Record source and dependency inputs |
| Every advertised preview works | Validate the assembled artifact, not just compiler exit codes |
| Predictable build resources | Limit concurrent compiler processes |
| Recoverable deployments | Keep complete, identifiable releases |

I would propose a 99.9% retrieval availability target and a full-build objective of
several minutes, then discuss the expected traffic and build machine. Those are
starting objectives, not properties guaranteed by choosing a CDN or a worker count.

## 📐 Estimate what matters — 4 minutes

For an example calculation, assume 10,000 visits per day and an average of 1 MB of
new static transfer per visit. That is about 10 GB of daily egress before cache
reuse, bots, and visits that explore many more libraries. We would measure actual
transfer before choosing a hosting plan.

If a visit makes twenty requests, the daily average is around 2.3 requests per
second. A launch could create a much larger burst, so averages alone do not size
the delivery path. Fortunately, most requests are for reusable static objects.

Build capacity has a different unit. Suppose one compiler uses 500 MB at peak and
takes thirty seconds. Fifty sequential builds take about twenty-five minutes;
four ideal parallel workers need at least thirteen rounds, about six and a half
minutes, before installation and assembly.

Real builds vary by library and contend for CPU and disk. I would use these numbers
to expose constraints, then replace them with measurements. Four workers cannot
magically reduce that example to a three-minute build.

The browser has another capacity limit: selected form/library pairs become separate
documents. CDN throughput and build parallelism do not solve excessive client memory.
I would keep that requirement visible while focusing this discussion on delivery.

## 🏗️ Draw the system — 4 minutes

```
┌─────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ Source revision │──▶│ Build workers    │──▶│ Staged release  │
│ + dependencies  │   │ bounded pool     │   │ + validation    │
└─────────────────┘   └──────────────────┘   └────────┬────────┘
                                                     │ promote
                                                     ▼
                                            ┌─────────────────┐
                                            │ Static origin   │
                                            └────────▲────────┘
                                                     │ cache miss
                                            ┌────────┴────────┐
                                            │ CDN             │
                                            └────────▲────────┘
                                                     │ requests
                                            ┌────────┴────────┐
                                            │ Browser         │
                                            │ shell + frames  │
                                            └─────────────────┘
```

I would distinguish the build path from the serving path. A deployment failure
should leave the last complete release serving normally. A traffic spike should
not cause more compiler jobs to run.

The origin can be managed static hosting or object storage. There is still an origin
behind the CDN: an uncached asset needs somewhere authoritative to come from.
Eliminating an application server does not eliminate that storage responsibility.

### Data and public interfaces

There is no SQL schema. The important records are a static catalog and release
metadata produced by the build process.

| Record | Key fields | Purpose |
|--------|------------|---------|
| Library catalog entry | Stable ID, entry path, supported themes | Defines what the shell advertises |
| Form definition | Stable ID, label, behavior expectations | Keeps examples comparable |
| Build result | Revision, library ID, outcome, artifact location | Explains which inputs produced which output |
| Release manifest | Revision, available previews, asset references | Supports validation and promotion |

At request time, the interface is small:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/20forms-20designs/` | Shell document; comparison parameters are parsed by the browser |
| GET | `/20forms-20designs/mui/index.html` | A library document; form/theme parameters initialize it |
| GET | `/20forms-20designs/mui/assets/<asset>` | JavaScript, styles, or another static asset |

There is no form-submission endpoint. A payment-looking preview should not silently
create a payment service requirement.

## 🔧 Deep dive 1: reliable builds under a memory limit — 9 minutes

> “I would use independent library builds and a bounded worker pool. That keeps
> dependency compatibility manageable while preventing the compiler processes from
> exhausting the runner. I would choose concurrency from measured memory and CPU,
> not from the number of applications.”

One combined application would be simpler to invoke, but it puts many dependency
versions, build plugins, and library assumptions into a shared environment. A change
to support one library could break another unrelated preview.

Separate applications reduce that coupling. They still need a reproducible package
resolution strategy, and they may duplicate dependencies in their outputs. The
benefit is that each library can be tested and debugged as a standalone artifact.

### Schedule work from a queue

The shell is required for every release, so I would build it early and fail promptly
if it cannot compile. Then workers take library jobs from a shared queue. When one
worker finishes, it takes the next job rather than waiting for an entire fixed batch.

That matters because a heavy enterprise UI library may compile much more slowly
than a small headless library. Fixed batches leave slots idle behind the slowest
job; a worker queue makes better use of the same concurrency budget.

The initial memory budget should include the operating system, dependency tooling,
parent process, and compiler peaks. I would leave headroom rather than divide all
available RAM by the average job size.

More workers can eventually make the build slower through CPU contention, disk
pressure, or swapping. Parallelism is a tuning control, not a monotonic speedup.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Bounded worker queue | Uses available slots without uncontrolled resource growth | Needs measurement and scheduling logic |
| ❌ Sequential builds | Simple and low memory | Feedback becomes slow as the catalog grows |
| ❌ Launch every build at once | Short theoretical critical path | Compiler peaks can overwhelm the runner |

### Separate transient and deterministic failures

A dependency download timeout may justify a bounded retry. A syntax error will not
be fixed by running the same compiler three times. I would record the failing phase
and make the retry policy match its failure modes.

For timed-out jobs, stop the child process before releasing its worker slot. Otherwise
“retry” can launch another compiler while the original still consumes memory. The
same lifecycle concern applies when a newer revision cancels an obsolete build.

An out-of-memory event may justify rerunning with lower concurrency, but I would
make that adjustment visible in the build result. Repeated automatic retries should
not hide a job whose resource use has grown beyond the budget.

Calling garbage collection in the parent does not free memory owned by still-running
compiler processes. I would track process completion and peak memory rather than
claiming a forced collection makes arbitrary parallelism safe.

### Cache inputs conservatively

Dependency download caching saves network work, but the installation step must still
resolve the required packages. Restoring a cache is not proof that dependencies are
correct for the current source.

If build time becomes a problem, I would cache library artifacts by their relevant
inputs: source, shared code, dependency resolution, build configuration, and toolchain.
An exact whole-repository revision is safe for reuse of that revision but provides
little reuse across ordinary commits by itself.

The hard part is shared changes. A shared form specification or a root dependency
override can invalidate many applications even if their folders did not change.
I would start with conservative rebuilds and add a dependency-aware cache only after
measuring that compilation is the bottleneck.

The concession is duplicate runtime bytes and some build orchestration. For a product
whose entries have different library requirements, that is a reasonable cost for
independent compatibility.

## 🔧 Deep dive 2: publish a coherent release — 9 minutes

> “My release invariant is that the shell never advertises a preview that the same
> release cannot serve. A successful shell build is not enough. I would validate
> the complete artifact before making it public.”

Suppose the shell catalog adds a library, but that library fails to compile. If the
pipeline publishes all successful outputs anyway, the home page works and the new
preview is blank. A superficial health check reports success while the core product
contains a broken comparison.

There is another local failure mode: an old output directory can survive a failed
rebuild. A copy script may then assemble current shell code with stale library code.
Cleaning only the final aggregate directory does not remove stale per-app outputs.

### Build and validate in a staging area

I would use a clean staging area associated with a source revision. The assembly
step consumes explicit successful build artifacts rather than discovering any old
output directory that happens to exist.

Validation checks the relationship between the catalog and the artifact:

1. The shell entry document exists.
2. Every advertised library has an entry document.
3. Referenced scripts, styles, and other required local assets exist.
4. Asset URLs resolve under the real deployment base path.
5. Representative library forms render inside the assembled shell.

The last step catches failures that file existence does not: runtime import errors,
invalid form IDs, or a preview that loads HTML but never displays the requested form.

I would validate all catalog-to-entry mappings and sample deeper behaviors across
forms and library families. Running every interaction in every combination on every
small change may be too expensive; targeted tests and a broader periodic suite can
cover different risks.

### Complete versus partial release

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Require all advertised previews | Simple product guarantee | One broken required library can delay a release |
| ❌ Silently publish successful builds only | Faster publication | Catalog can link to missing or stale content |
| Alternative: explicit reduced catalog | Allows a deliberate partial release | Requires manifest filtering and a clear unavailable state |

I would initially block a release when an advertised library fails. For a showcase,
a previous complete release is usually more useful than a new broken one.

If frequent upstream library breakages make this too restrictive, we can support an
explicit partial release. The release manifest and shell must agree about what is
available. That is a product decision, not something inferred from “most builds passed.”

### Promotion and rollback

The publish step should make a validated release available without exposing an
intermediate upload. Managed hosting may provide artifact-level deployment; with
object storage, I would upload an immutable release and then change a small pointer
or routing configuration.

A pointer switch does not instantly update every cache or already-open browser.
Therefore the complete-release invariant also requires a compatibility policy for
older HTML and its referenced assets.

For rollback, retain a known-good complete artifact and its revision. Restoring that
artifact is more predictable than rebuilding old source with changed dependency
resolution or manually mixing one old library into a new release.

Concurrent deployments need ordering too. An older slow build must not become live
after a newer release merely because it finished later. I would serialize promotion
or check that the revision is still eligible to publish.

This design adds artifact storage and release metadata. I accept those costs because
partial or mixed deployments are difficult to detect from the home page alone.

## 🔧 Deep dive 3: cache aggressively without breaking releases — 8 minutes

> “I would give immutable asset bytes stable content-derived names and keep entry
> documents fresh enough to discover new releases. The important detail is that
> old documents must still be able to load the assets they reference.”

The read path is straightforward. A browser requests a shell or library document.
The CDN serves a usable cached response or fetches it from the static origin. The
browser then fetches the scripts and styles referenced by that document.

Content-hashed assets let us change bytes by creating a new name. An unchanged file
can continue to be reused, while a changed file does not overwrite old content at
the same immutable URL.

For HTML, I would use revalidation or a deliberately short freshness period where
the hosting platform permits it. `no-cache` allows a stored response but requires
validation before reuse; it is different from `no-store`.

### A deployment race worth explaining

A user loads an old library document just before deployment. Minutes later, the app
requests another chunk or the user reopens a cached entry page. If deployment deleted
all old hashed files, that valid old document can now request a missing asset.

The hash did its job: it identified the old bytes correctly. The failure was removing
those bytes before their references stopped being used.

I would retain older assets for a defined window or serve release-specific paths.
The retention policy should account for cache lifetimes and long-lived sessions.
If we cannot retain indefinitely, we need an explicit recovery experience for stale
clients, such as a controlled reload after an asset failure.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Hashed assets with controlled HTML freshness and retention | Reuse without overwriting referenced bytes | More storage and lifecycle management |
| ❌ Long-cache everything under stable names | Few validation requests | New releases may remain hidden or mix old and new files |
| ❌ Disable caching for all assets | Simple freshness model | Repeated heavy transfers across a comparison session |

Query parameters select the form and theme in the browser; they do not normally
change the underlying library HTML bytes. A CDN may include the query string in
its cache key, which can fragment equivalent document responses. I would inspect
that behavior before adding custom cache-key rules.

If we normalize document cache keys, the visible browser URL must still retain its
configuration. Ignoring parameters for caching is different from stripping them
from the navigation or changing application semantics.

### Avoid provider promises without evidence

Managed static hosting is a good initial fit. Exact cache headers, traffic limits,
artifact retention, and pricing depend on the provider and configuration. I would
verify those details when selecting a host rather than making them part of a
whiteboard correctness argument.

A CDN also does not guarantee sub-100 ms latency everywhere. Network distance,
connection setup, misses, and device execution all contribute. Measure retrieval
and application readiness as distinct outcomes.

## 📊 Operations and close — 6 minutes

I would keep the first operational view small:

| Signal | What it tells us |
|--------|------------------|
| Build duration and memory by library | Which entries constrain throughput |
| Failed advertised previews | Whether the release invariant was violated |
| Asset failures by release | Whether publication or retention broke references |
| CDN hit ratio and origin transfer | Whether caching matches the workload |
| Synthetic preview readiness | Whether a document actually renders the selected form |

During a compiler failure, keep serving the last release. During a single preview
failure in production, keep the shell usable and show a local recovery action.
During origin unavailability, cached assets may still be usable according to cache
policy, but cold misses and mandatory revalidation remain vulnerable.

For security, the serving layer needs HTTPS and appropriately scoped deployment
credentials. The static examples should not collect credentials just because a form
looks like a login screen. Arbitrary uploaded code would require a separate design
for origins and execution permissions.

I would verify the assembled production artifact rather than only the development
shell. A shell test can confirm that a frame element exists while the URL inside it
returns the wrong content. Base-path mistakes are especially easy to miss locally.

If the catalog doubles, I would first inspect the build-duration distribution and
cache invalidation boundaries. If traffic doubles, I would inspect transfer and CDN
behavior. If browsers become slow, I would reduce mounted previews. These are three
different scaling problems with different controls.

> “The main backend decision is to keep runtime serving static and put reliability
> into the build and release path. Independent builds run within measured resource
> limits, a validated artifact keeps the catalog honest, and asset retention makes
> caching compatible with updates and rollback. I would add dynamic services only
> when a new user requirement creates server-owned data or computation.”
