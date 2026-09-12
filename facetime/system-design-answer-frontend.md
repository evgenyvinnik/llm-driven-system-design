# FaceTime: Frontend System Design Interview

## 🎯 Scope and User Experience — 4 minutes

> “I’ll design a browser-based calling experience inspired by FaceTime. The frontend has two
> jobs that must stay coordinated: represent the service’s call decisions and own the
> camera, microphone, and peer connection safely.”

I would start with one-to-one audio/video calls, a contact picker, incoming-call
notification, local preview, remote media, mute/video controls, and hangup. Calls can ring
several registered devices, but only one device accepts each invitation. I would defer
screen sharing, background effects, recording, and device transfer until the basic lifecycle
is reliable.

Group calling is an extension with a different media topology. The interface can later show
a bounded participant grid and speaker view, but adding more video elements does not turn a
one-peer implementation into a working conference.

The first clarification is what “connected” means. A WebSocket can be connected while the
camera permission prompt is open. A call can be accepted while ICE is still finding a media
path. Media can keep flowing briefly after signaling disconnects. One boolean cannot
describe all three conditions.

| User-visible condition | What the interface should communicate |
|------------------------|---------------------------------------|
| Preparing media | Waiting for permission or acquiring a device |
| Ringing | Invitation exists; another person has not accepted yet |
| Accepted / connecting | A device won the invitation; media is negotiating |
| Active media | The peer connection and incoming media are usable |
| Signaling interrupted | Call control is reconnecting; media may still work |
| Media interrupted | Audio/video path needs recovery or has failed |
| Ended | Resources are released and late events cannot restart the call |

I would target p95 below two seconds from requesting a call to ringing an online device, and
below three seconds from acceptance to usable media on supported networks. Human response
time is outside that setup target. Media delay should aim below 200 ms one-way within a
region, with actual device and network conditions measured.

These are proposed targets, not performance results from the repository. The frontend must
remain understandable when permission is denied, the relay is unavailable, or the other
person never answers.

## 🏗️ Frontend Architecture and State — 6 minutes

> “I’ll keep browser resources in one call controller. React renders a small state model
> from that controller and sends it user actions.”

```
┌──────────────────────┐     ┌──────────────────────┐
│ React views/controls │────▶│ Call controller      │
└──────────────────────┘     └──────────┬───────────┘
                                        │
              ┌─────────────────────────┤
              ▼                         ▼
┌──────────────────────┐     ┌──────────────────────┐
│ Signaling adapter    │     │ Media / peer owner   │
│ Session + call events│     │ Tracks + negotiation │
└──────────────────────┘     └──────────┬───────────┘
                                        ▼
                             ┌──────────────────────┐
                             │ Native video/audio   │
                             └──────────────────────┘
```

The signaling adapter handles authenticated connection setup, registration acknowledgment,
typed commands, and reconnection. The media owner manages capture, the peer connection,
descriptions, candidate queues, and cleanup. The controller is the place where a server
acceptance becomes permission to negotiate a particular call attempt.

The views include identity/contact selection, incoming invitation, and the active call. I
would not introduce a router just to switch between ringing and connected states. If
persistent history and settings become navigable pages, routing can be added around the call
controller without tying the call’s lifetime to a page component.

| State or resource | Owner | Reason |
|-------------------|-------|--------|
| Account and verified device | Session layer | Defines who may send call commands |
| Call ID, revision, invitation outcome | Server mirrored by controller | Determines accepted participation and terminal state |
| Media phase and selected devices | Media owner | Describes local browser reality |
| Peer connection and streams | Controller-owned refs | Mutable resources need explicit disposal |
| Candidate/description queues | One peer and negotiation generation | Old negotiation data cannot leak into another attempt |
| Control display and selected contact | React/Zustand state | Drives a responsive interface |
| Retry timers and subscriptions | Signaling session | Must end on logout or session replacement |

A Zustand store is reasonable for the UI model, but it is not the ownership policy. Putting
a MediaStream in a store does not tell us who stops it. Likewise, setting the call state to
idle does not close an RTCPeerConnection or cancel a pending permission result.

I would identify every attempt by account, call ID, endpoint identity, and a local
generation. Async work checks that identity before publishing results. A new call increments
the generation; a late result from the old generation is discarded and any resource it
produced is released.

Registration success is also a distinct state. The socket’s open event only says a transport
exists. Call buttons become available after the server accepts the authenticated
registration, so an immediate click is not lost while registration is still awaiting
storage.

## 🎥 Deep Dive: Owning Media and Rendering It — 9 minutes

> “I’ll use native media elements and a controller with explicit acquisition and disposal.
> The difficult part is lifetime management, not getting a video tag onto the screen.”

Capture begins from an intentional user action. For an outgoing video call, request
microphone and camera; for audio-only, request only the microphone. Incoming ringing itself
should not unexpectedly activate the camera. The callee can request media when choosing
Accept, then attempt the server claim before advertising that they joined.

The permission request may take seconds or never resolve while the person is looking at the
prompt. During that interval the caller may hang up or another device may answer. The
original async function must not continue as though the invitation were still valid.

I would capture the attempt generation before requesting media. When the promise resolves,
compare it with the current generation and terminal state. If it is stale, stop every newly
acquired track immediately. Only a current attempt can attach that stream to a peer
connection.

That same rule applies to device replacement. Keep the previous usable track until the
replacement is acquired and accepted by the sender. If the operation fails or becomes stale,
release the replacement and leave the current call in a clearly described state.

| Resource strategy | Benefit | Cost or failure |
|-------------------|---------|-----------------|
| ✅ One controller owns acquisition and disposal | Cleanup follows a call attempt consistently | Requires explicit cancellation/generation checks |
| ❌ Each view acquires its own media | Easy to prototype a screen | Navigation and remounts can leave duplicate or orphaned tracks |
| ❌ A global stream with no attempt identity | Convenient shared access | Late work can attach a previous call’s media to a new call |

Hangup invalidates the attempt first, stops retry work for that attempt, closes the peer
connection, clears candidate queues, detaches media elements, and stops locally owned
tracks. Repeated cleanup should be harmless. Server notification can be retried
independently; camera release should not wait for a network round trip.

The controller must distinguish reusable session resources from call resources. Ending one
call should not close an authenticated signaling connection needed for the next invitation.
Logging out, however, disables reconnect and disposes both the session and any current call.

For rendering, assign the stream to a native video element’s srcObject. A muted local
preview avoids playing the microphone back through the speakers. Mirroring the local preview
can match user expectations, while the transmitted media remains unchanged by that CSS
transformation.

Use inline playback where supported and handle a rejected playback attempt with a visible
action. Autoplay attributes are not a guarantee that a browser will play remote audio under
every policy. An audio-only call also needs an intentional avatar/status presentation
instead of a blank area labeled “No video.”

Native media elements keep decoding and presentation in the browser’s media pipeline. React
should update controls, names, and status rather than process every frame. A canvas or
frame-processing pipeline is useful for an actual effect, but it introduces extra work,
resource handling, and compatibility concerns that ordinary calling does not require.

| Rendering choice | Why choose it | Trade-off |
|------------------|---------------|-----------|
| ✅ Native video/audio elements | Browser media pipeline and straightforward stream binding | Less direct control over individual frames |
| ❌ Canvas for every displayed frame | Useful for custom compositing/effects | Additional frame transfer, scheduling, and cleanup work |
| ❌ Recreate the media element on every status update | Simple conditional markup | Can interrupt playback and discard element state |

Mute and camera-off need precise semantics. Disabling a track is different from stopping it
and releasing the device. I would define the control’s product behavior, show it accurately,
and signal the status to peers. If camera-off promises device release, re-enabling must
handle a fresh acquisition and possible permission/device failure.

Capture constraints express preferences and supported requirements, not guaranteed camera
quality. Requesting 720p at 30 fps does not mean every device provides it. I would expose a
usable fallback and record the actual track settings for diagnostics where appropriate.

The cost of a resource owner is more lifecycle code and tests. It is justified because an
invisible camera left running, or a stream attached after hangup, is a much more serious
product failure than a delayed visual transition.

## 🔄 Deep Dive: Negotiation Without Stale Events — 9 minutes

> “I’ll treat offer/answer and candidates as one serialized negotiation for a specific
> endpoint pair. A call ID alone is not enough once retries, reconnects, and ICE restarts
> exist.”

The controller first gets usable ICE configuration, creates the peer connection for the
current attempt, attaches handlers, and adds local tracks. It designates an initial offerer.
The caller sends an offer only after the server has identified the accepted answering
endpoint.

The peer installs the remote description, creates an answer, and returns it through
authorized signaling. ICE gathers host, reflexive, and relay candidates as appropriate and
tests candidate pairs. The application carries the negotiation messages; the browser handles
the connectivity checks and media transport.

WebSocket is a practical signaling choice because invitations and negotiation messages
travel in both directions. It is not required by WebRTC itself. HTTP-based signaling is
possible, but the application still needs timely server-to-client delivery and a coherent
order for each negotiation.

Trickle ICE can begin checking usable candidates without waiting for every interface and
relay allocation to finish. That improves setup opportunities on ordinary networks, but it
requires handling candidates that arrive before the matching remote description.

I would queue those candidates under the current peer and negotiation generation. After
installing the description, drain the matching queue in order. Bound it by time and size,
handle invalid candidates explicitly, and clear it when the attempt is abandoned.

| Candidate strategy | Benefit | Cost or limitation |
|--------------------|---------|--------------------|
| ✅ Trickle candidates with scoped queues | Start connectivity checks as candidates become available | Requires ordering and generation-aware buffering |
| ❌ Wait for complete gathering every time | Simpler initial message bundle | A slow interface or relay can delay the entire setup |
| ❌ One global candidate queue | Minimal bookkeeping | Candidates from an old call or restart can contaminate a new peer |

An event handler installed on a long-lived peer must not capture an obsolete render’s call
ID. I would bind it to an immutable attempt object or read the current validated attempt
through a controlled reference. Recreating a React callback later does not automatically
replace handlers already attached to an existing peer.

Incoming events also carry the accepted endpoint pair and generation. The client checks them
before changing its peer or UI. A delayed call_end for call A must not close call B, and an
SDP offer from an unrelated user must be rejected by the server before the browser sees it.

Later changes can produce simultaneous offers, often called glare. I would use a documented
negotiation policy with polite/impolite roles or equivalent deterministic collision
handling. Each peer serializes description operations and has a bounded recovery path.
Simply allowing several async message handlers to mutate the same connection at once is not
a policy.

An ICE restart creates a later negotiation generation with new ICE credentials. Candidate
deduplication must respect that generation and media section. A hash of the candidate string
by itself cannot tell whether an old candidate is valid for the new attempt.

TURN configuration is part of this lifecycle. Fetch it from the actual API route before
constructing the peer, and surface failure rather than silently claiming relay support. A
fallback with only public STUN may connect on some networks, but it cannot allocate a TURN
relay it was never told about.

Likewise, the configured relay must be reachable from the browser’s machine. A localhost
TURN URL points to that machine, and publishing a TLS port does not enable a TLS listener. A
real relay test should inspect the selected candidate pair and media counters, not merely
see a successful credential response.

The trade-off is more protocol state in the client. It buys a way to reject stale work and
recover predictably, which is essential once a person ends one call and quickly starts
another.

## 📱 Deep Dive: Device Races and Recovery — 9 minutes

> “The server decides who accepted the invitation; each browser decides whether its media is
> actually usable. The UI reconciles those facts without inventing a winner locally.”

Suppose Alice’s laptop and phone both ring. Each displays the same invitation revision and
deadline. When both attempt acceptance, the server atomically claims one invited seat and
returns the same winning device to every participant. The losing device releases any media
it acquired and shows that the call was answered elsewhere.

This check must also cover busy state across different calls. A server that only locks one
call row could allow the same user to accept two unrelated calls on different devices. The
browser can prevent double taps, but only server-side claims can enforce the cross-device
rule.

The frontend waits for a canonical acceptance response before entering media negotiation. It
does not mark itself connected simply because it sent an Accept message. A response may be
lost after commitment, so acceptance uses a stable operation ID and a retryable recorded
result.

Initiation follows the same principle. A retry sends the same identity and body until the
outcome is known. A deliberate new call gets a new operation ID. Otherwise double taps and
reconnects can create several invitations for one intended action.

| Recovery approach | Strength | Cost or failure |
|-------------------|----------|-----------------|
| ✅ Server revision plus retry receipts and local media phase | Resolves uncertain commands and device races | Requires synchronization after reconnect |
| ❌ Trust the local button state | Fast-looking transitions | Another device can win while this one claims success |
| ❌ Tear down on every signaling interruption | Simple cleanup policy | Drops healthy direct media during a transient control outage |

If signaling disconnects while direct audio continues, I would show a reconnecting-control
indication and preserve the media for a bounded grace period. Hangup still releases local
resources immediately. The end command can be delivered after reconnect if the server still
considers the call active.

On reconnect, authenticate and register the connection, then query or receive the current
call revision and endpoint claim. Do not assume re-registration restored the call. If it
ended or another device owns the seat, clean up. If the claim remains valid, preserve
healthy media and negotiate only if necessary.

If media fails while signaling remains healthy, the controller can attempt a bounded ICE
restart with refreshed configuration and a new generation. A transient disconnected event is
not always terminal, but an indefinite spinner is not recovery either. Use deadlines and a
clear final failure state.

A new incoming call during an active call needs an explicit busy/call-waiting policy. For
the initial scope, I would keep one accepted call and return busy according to server state.
An unfiltered incoming ring must not replace the active call object and orphan its streams.

Presence uses connection identities independently of account/device identity. Two tabs may
share a device registration but still have distinct live sockets. Closing one cannot remove
the other’s presence. The UI should consume server presence updates or a refreshed contact
resource instead of equating a contact’s database device row with being online.

There is a cost to preserving media through signaling loss: control state may be temporarily
uncertain, and hangup/revocation deadlines need a documented policy. I would prefer that
bounded uncertainty to discarding a healthy conversation for every brief WebSocket
interruption.

## 📊 Quality, Accessibility, and Verification — 6 minutes

I would collect a small set of browser statistics at a bounded interval: selected candidate
pair, round-trip time, packet loss and jitter, incoming/outgoing media progress, and frames
decoded or dropped. These distinguish “accepted but no media” from “media flowing with poor
quality.” A green signaling dot cannot do that.

Use sustained observations rather than switching quality on one noisy sample. Preserve audio
first, then reduce video bitrate, frame rate, resolution, or subscriptions as appropriate to
the topology. Browser congestion control already operates; application policy should
complement it instead of pretending to implement all transport adaptation itself.

For a future group view, render a bounded set of visible participants and request suitable
streams/layers from the SFU. Hiding a video tile with CSS alone does not stop network
delivery or decode work. Keep participant identity stable while rearranging tiles so active
media elements are not unnecessarily recreated.

Controls need accessible names and pressed states. Announce meaningful call changes without
reading every quality sample. Incoming invitations require focus management, keyboard
acceptance/decline, and reduced-motion behavior. Avoid trapping ordinary text-entry
shortcuts when contact search or device settings have focus.

| Scenario | What I would verify |
|----------|--------------------|
| Permission resolves after Hang Up | Returned tracks are stopped and no new peer becomes active |
| Two devices accept simultaneously | One winner; losing device releases capture and stops ringing |
| Candidate arrives before description | It reaches only the matching peer after description installation |
| Late event from the previous call | Current call and media remain unchanged |
| Signaling drops but audio continues | UI reports control recovery without immediately dropping audio |
| TURN-only network path | Relay pair is selected and media counters advance |
| Logout while reconnect is scheduled | No old-identity connection is reopened |
| Remote autoplay is blocked | User gets an actionable playback control |

Tests should include mocked controller races, real socket/database acceptance, and two
browser contexts exchanging synthetic or permitted media. A screenshot of the contacts page
proves neither microphone cleanup nor successful relay traversal.

The main performance rule is to leave frame delivery in the browser media pipeline and keep
React updates tied to meaningful state. I would profile CPU, decode load, battery-sensitive
behavior, and control responsiveness before adding custom frame processing or broad
memoization.

## 🏁 Implementation Boundary — 2 minutes

The local project uses React, Zustand, native video elements, one peer connection, and
mouse/tap call controls. It requests browser audio processing and uses normal WebRTC
transport encryption. It has no group grid/SFU, media-quality telemetry, device transfer, or
call recovery protocol.

Its default credential request misses the Vite proxy, caller candidate handlers can retain
an empty call ID, incoming events and queues lack attempt scoping, and logout can reconnect
the previous identity. Server acceptance and membership checks also have correctness gaps.
The [architecture document](architecture.md#implementation-notes) maps these limits to
source.

> “My first frontend milestone would be a call that acquires media only for its current
> attempt, reflects a verified server acceptance, and releases every resource after
> cancellation. I would then demonstrate the same guarantees through permission delays,
> device races, and reconnecting.”
