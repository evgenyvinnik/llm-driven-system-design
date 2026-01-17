export default `# Overview

**TanStack Router is a router for building React and Solid applications**. Some of its features include:

- 100% inferred TypeScript support
- Typesafe navigation
- Nested Routing and layout routes (with pathless layouts)
- Built-in Route Loaders w/ SWR Caching
- Designed for client-side data caches (TanStack Query, SWR, etc.)
- Automatic route prefetching
- Asynchronous route elements and error boundaries
- File-based Route Generation
- Typesafe JSON-first Search Params state management APIs
- Path and Search Parameter Schema Validation
- Search Param Navigation APIs
- Custom Search Param parser/serializer support
- Search param middleware
- Route matching/loading middleware

To get started quickly, head to the next page. For a more lengthy explanation, buckle up while I bring you up to speed!

## "A Fork in the Route"

Using a router to build applications is widely regarded as a must-have and is usually one of the first choices you’ll make in your tech stack.

## Why TanStack Router?

TanStack Router delivers on the same fundamental expectations as other routers that you’ve come to expect:

- Nested routes, layout routes, grouped routes
- File-based Routing
- Parallel data loading
- Prefetching
- URL Path Params
- Error Boundaries and Handling
- SSR
- Route Masking

And it also delivers some new features that raise the bar:

- 100% inferred TypeScript support
- Typesafe navigation
- Built-in SWR Caching for loaders
- Designed for client-side data caches (TanStack Query, SWR, etc.)
- Typesafe JSON-first Search Params state management APIs
- Path and Search Parameter Schema Validation
- Search Parameter Navigation APIs
- Custom Search Param parser/serializer support
- Search param middleware
- Inherited Route Context
- Mixed file-based and code-based routing

Let’s dive into some of the more important ones in more detail!

## 100% Inferred TypeScript Support

Everything these days is written “in Typescript” or at the very least offers type definitions that are veneered over runtime functionality, but too few packages in the ecosystem actually design their APIs with TypeScript in mind. So while I’m pleased that your router is auto-completing your option fields and catching a few property/method typos here and there, there is much more to be had.

- TanStack Router is fully aware of all of your routes and their configuration at any given point in your code. This includes the path, path params, search params, context, and any other configuration you’ve provided. Ultimately this means that you can navigate to any route in your app with 100% type safety and confidence that your link or navigate call will succeed.
- TanStack Router provides lossless type-inference. It uses countless generic type parameters to enforce and propagate any type information you give it throughout the rest of its API and ultimately your app. No other router offers this level of type safety and developer confidence.

What does all of that mean for you?

- Faster feature development with auto-completion and type hints
- Safer and faster refactors
- Confidence that your code will work as expected

## 1st Class Search Parameters

Search parameters are often an afterthought, treated like a black box of strings (or string) that you can parse and update, but not much else. Existing solutions are **not** type-safe either, adding to the caution that is required to deal with them. Even the most "modern" frameworks and routers leave it up to you to figure out how to manage this state. Sometimes they'll parse the search string into an object for you, or sometimes you're left to do it yourself with \`URLSearchParams\`.

Let's step back and remember that **search params are the most powerful state manager in your entire application.** They are global, serializable, bookmarkable, and shareable making them the perfect place to store any kind of state that needs to survive a page refresh or a social share.

To live up to that responsibility, search parameters are a first-class citizen in TanStack Router. While still based on standard URLSearchParams, TanStack Router uses a powerful parser/serializer to manage deeper and more complex data structures in your search params, all while keeping them type-safe and easy to work with.

**It's like having \`useState\` right in the URL!**

Search parameters are:

- Automatically parsed and serialized as JSON
- Validated and typed
- Inherited from parent routes
- Accessible in loaders, components, and hooks
- Easily modified with the useSearch hook, Link, navigate, and router.navigate APIs
- Customizable with a custom search filters and middleware
- Subscribed via fine-grained search param selectors for efficient re-renders

Once you start using TanStack Router's search parameters, you'll wonder how you ever lived without them.

## Built-In Caching and Friendly Data Loading

Data loading is a critical part of any application and while most existing routers offer some form of critical data loading APIs, they often fall short when it comes to caching and data lifecycle management. Existing solutions suffer from a few common problems:

- No caching at all. Data is always fresh, but your users are left waiting for frequently accessed data to load over and over again.
- Overly-aggressive caching. Data is cached for too long, leading to stale data and a poor user experience.
- Blunt invalidation strategies and APIs. Data may be invalidated too often, leading to unnecessary network requests and wasted resources, or you may not have any fine-grained control over when data is invalidated at all.

TanStack Router solves these problems with a two-prong approach to caching and data loading:

### Built-in Cache

TanStack Router provides a light-weight built-in caching layer that works seamlessly with the Router. This caching layer is loosely based on TanStack Query, but with fewer features and a much smaller API surface area. Like TanStack Query, sane but powerful defaults guarantee that your data is cached for reuse, invalidated when necessary, and garbage collected when not in use. It also provides a simple API for invalidating the cache manually when needed.

### Flexible & Powerful Data Lifecycle APIs

TanStack Router is designed with a flexible and powerful data loading API that more easily integrates with existing data fetching libraries like TanStack Query, SWR, Apollo, Relay, or even your own custom data fetching solution. Configurable APIs like \`context\`, \`beforeLoad\`, \`loaderDeps\` and \`loader\` work in unison to make it easy to define declarative data dependencies, prefetch data, and manage the lifecycle of an external data source with ease.

## Inherited Route Context

TanStack Router's router and route context is a powerful feature that allows you to define context that is specific to a route which is then inherited by all child routes. Even the router and root routes themselves can provide context. Context can be built up both synchronously and asynchronously, and can be used to share data, configuration, or even functions between routes and route configurations. This is especially useful for scenarios like:

- Authentication and Authorization
- Hybrid SSR/CSR data fetching and preloading
- Theming
- Singletons and global utilities
- Curried or partial application across preloading, loading, and rendering stages

Also, what would route context be if it weren't type-safe? TanStack Router's route context is fully type-safe and inferred at zero cost to you.

## File-based and/or Code-Based Routing

TanStack Router supports both file-based and code-based routing at the same time. This flexibility allows you to choose the approach that best fits your project's needs.

TanStack Router's file-based routing approach is uniquely user-facing. Route configuration is generated for you either by the Vite plugin or TanStack Router CLI, leaving the usage of said generated code up to you! This means that you're always in total control of your routes and router, even if you use file-based routing.

## Acknowledgements

TanStack Router builds on concepts and patterns popularized by many other OSS projects, including:

- [TRPC](https://trpc.io/)
- [Remix](https://remix.run)
- [Chicane](https://swan-io.github.io/chicane/)
- [Next.js](https://nextjs.org)

We acknowledge the investment, risk and research that went into their development, but are excited to push the bar they have set even higher.

## Let's go!

Enough overview, there's so much more to do with TanStack Router. Hit that next button and let's get started!

# Quick Start

## Impatient?

The fastest way to get started with TanStack Router is to scaffold a new project. Just run:

[//]: # 'createAppCommand'

\`\`\`sh
npx create-tsrouter-app@latest
\`\`\`

[//]: # 'createAppCommand'

The CLI will guide you through a short series of prompts to customize your setup, including options for:

[//]: # 'CLIPrompts'

- File-based or code-based route configuration
- TypeScript support
- Tailwind CSS integration
- Toolchain setup
- Git initialization

[//]: # 'CLIPrompts'

Once complete, a new React project will be generated with TanStack Router installed and ready to use:

\`\`\`sh
cd your-project-name
npm run dev
\`\`\`

> [!TIP]
> For full details on available options and templates, visit the [\`create-tsrouter-app\` documentation](https://github.com/TanStack/create-tsrouter-app/tree/main/cli/create-tsrouter-app).

## Routing Options

TanStack Router supports both file-based and code-based route configurations. You can specify your preference during the CLI setup, or use these commands directly:

### File-Based Route Generation

The file-based approach is the recommended option for most projects. It automatically creates routes based on your file structure, giving you the best mix of performance, simplicity, and developer experience.

[//]: # 'createAppCommandFileBased'

\`\`\`sh
npx create-tsrouter-app@latest my-app --template file-router
\`\`\`

[//]: # 'createAppCommandFileBased'

### Code-Based Route Configuration

If you prefer to define routes programmatically, you can use the code-based route configuration. This approach gives you full control over routing logic.

[//]: # 'createAppCommandCodeBased'

\`\`\`sh
npx create-tsrouter-app@latest my-app
\`\`\`

[//]: # 'createAppCommandCodeBased'

With either approach, navigate to your project directory and start the development server:

\`\`\`sh
cd my-app
npm run dev
\`\`\`

## Existing Project

If you have an existing React project and want to add TanStack Router to it, you can install it manually.

### Requirements

Before installing TanStack Router, please ensure your project meets the following requirements:

[//]: # 'Requirements'

- \`react\` v18 or later with \`createRoot\` support.
- \`react-dom\` v18 or later.

[//]: # 'Requirements'

> [!NOTE]
> Using TypeScript (\`v5.3.x or higher\`) is recommended for the best development experience, though not strictly required. We aim to support the last 5 minor versions of TypeScript, but using the latest version will help avoid potential issues.

TanStack Router is currently only compatible with React (with ReactDOM) and Solid. If you're interested in contributing to support other frameworks, such as React Native, Angular, or Vue, please reach out to us on [Discord](https://tlinz.com/discord).

### Installation

To install TanStack Router in your project, run the following command using your preferred package manager:

[//]: # 'installCommand'

\`\`\`sh
npm install @tanstack/react-router
# or
pnpm add @tanstack/react-router
#or
yarn add @tanstack/react-router
# or
bun add @tanstack/react-router
# or
deno add npm:@tanstack/react-router
\`\`\`

[//]: # 'installCommand'

Once installed, you can verify the installation by checking your \`package.json\` file for the dependency.

[//]: # 'packageJson'

\`\`\`json
{
  "dependencies": {
    "@tanstack/react-router": "^x.x.x"
  }
}
\`\`\`

[//]: # 'packageJson'

# Decisions on Developer Experience

When people first start using TanStack Router, they often have a lot of questions that revolve around the following themes:

> Why do I have to do things this way?

> Why is it done this way? and not that way?

> I'm used to doing it this way, why should I change?

And they are all valid questions. For the most part, people are used to using routing libraries that are very similar to each other. They all have a similar API, similar concepts, and similar ways of doing things.

But TanStack Router is different. It's not your average routing library. It's not your average state management library. It's not your average anything.

## TanStack Router's origin story

It's important to remember that TanStack Router's origins stem from [Nozzle.io](https://nozzle.io)'s need for a client-side routing solution that offered a first-in-class _URL Search Parameters_ experience without compromising on the **_type-safety_** that was required to power its complex dashboards.

And so, from TanStack Router's very inception, every facet of its design was meticulously thought out to ensure that its type-safety and developer experience were second to none.

## How does TanStack Router achieve this?

> TypeScript! TypeScript! TypeScript!

Every aspect of TanStack Router is designed to be as type-safe as possible, and this is achieved by leveraging TypeScript's type system to its fullest extent. This involves using some very advanced and complex types, type inference, and other features to ensure that the developer experience is as smooth as possible.

But to achieve this, we had to make some decisions that deviate from the norms in the routing world.

1. [**Route configuration boilerplate?**](#why-is-the-routers-configuration-done-this-way): You have to define your routes in a way that allows TypeScript to infer the types of your routes as much as possible.
2. [**TypeScript module declaration for the router?**](#declaring-the-router-instance-for-type-inference): You have to pass the \`Router\` instance to the rest of your application using TypeScript's module declaration.
3. [**Why push for file-based routing over code-based?**](#why-is-file-based-routing-the-preferred-way-to-define-routes): We push for file-based routing as the preferred way to define your routes.

> TLDR; All the design decisions in the developer experience of using TanStack Router are made so that you can have a best-in-class type-safety experience without compromising on the control, flexibility, and maintainability of your route configurations.

## Why is the Router's configuration done this way?

When you want to leverage the TypeScript's inference features to its fullest, you'll quickly realize that _Generics_ are your best friend. And so, TanStack Router uses Generics everywhere to ensure that the types of your routes are inferred as much as possible.

This means that you have to define your routes in a way that allows TypeScript to infer the types of your routes as much as possible.

> Can I use JSX to define my routes?

Using JSX for defining your routes is **out of the question**, as TypeScript will not be able to infer the route configuration types of your router.

\`\`\`tsx
// ⛔️ This is not possible
function App() {
  return (
    <Router>
      <Route path="/posts" component={PostsPage} />
      <Route path="/posts/$postId" component={PostIdPage} />
      {/* ... */}
    </Router>
    // ^? TypeScript cannot infer the routes in this configuration
  )
}
\`\`\`

And since this would mean that you'd have to manually type the \`to\` prop of the \`<Link>\` component and wouldn't catch any errors until runtime, it's not a viable option.

> Maybe I could define my routes as a tree of nested objects?

\`\`\`tsx
// ⛔️ This file will just keep growing and growing...
const router = createRouter({
  routes: {
    posts: {
      component: PostsPage, // /posts
      children: {
        $postId: {
          component: PostIdPage, // /posts/$postId
        },
      },
    },
    // ...
  },
})
\`\`\`

At first glance, this seems like a good idea. It's easy to visualize the entire route hierarchy in one go. But this approach has a couple of big downsides that make it not ideal for large applications:

- **It's not very scalable**: As your application grows, the tree will grow and become harder to manage. And since it's all defined in one file, it can become very hard to maintain.
- **It's not great for code-splitting**: You'd have to manually code-split each component and then pass it into the \`component\` property of the route, further complicating the route configuration with an ever-growing route configuration file.

This only gets worse as you begin to use more features of the router, such as nested context, loaders, search param validation, etc.

> So, what's the best way to define my routes?

What we found to be the best way to define your routes is to abstract the definition of the route configuration outside of the route-tree. Then stitch together your route configurations into a single cohesive route-tree that is then passed into the \`createRouter\` function.

You can read more about [code-based routing](./routing/code-based-routing.md) to see how to define your routes in this way.

> [!TIP]
> Finding Code-based routing to be a bit too cumbersome? See why [file-based routing](#why-is-file-based-routing-the-preferred-way-to-define-routes) is the preferred way to define your routes.

## Declaring the Router instance for type inference

> Why do I have to declare the \`Router\`?

> This declaration stuff is way too complicated for me...

Once you've constructed your routes into a tree and passed it into your Router instance (using \`createRouter\`) with all the generics working correctly, you then need to somehow pass this information to the rest of your application.

There were two approaches we considered for this:

1. **Imports**: You could import the \`Router\` instance from the file where you created it and use it directly in your components.

\`\`\`tsx
import { router } from '@/src/app'
export const PostsIdLink = () => {
  return (
    <Link<typeof router> to="/posts/$postId" params={{ postId: '123' }}>
      Go to post 123
    </Link>
  )
}
\`\`\`

A downside to this approach is that you'd have to import the entire \`Router\` instance into every file where you want to use it. This can lead to increased bundle sizes and can be cumbersome to manage, and only get worse as your application grows and you use more features of the router.

2. **Module declaration**: You can use TypeScript's module declaration to declare the \`Router\` instance as a module that can be used for type inference anywhere in your application without having to import it.

You'll do this once in your application.

\`\`\`tsx
// src/app.tsx
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
\`\`\`

And then you can benefit from its auto-complete anywhere in your app without having to import it.

\`\`\`tsx
export const PostsIdLink = () => {
  return (
    <Link
      to="/posts/$postId"
      // ^? TypeScript will auto-complete this for you
      params={{ postId: '123' }} // and this too!
    >
      Go to post 123
    </Link>
  )
}
\`\`\`

We went with **module declaration**, as it is what we found to be the most scalable and maintainable approach with the least amount of overhead and boilerplate.

## Why is file-based routing the preferred way to define routes?

> Why are the docs pushing for file-based routing?

> I'm used to defining my routes in a single file, why should I change?

Something you'll notice (quite soon) in the TanStack Router documentation is that we push for **file-based routing** as the preferred method for defining your routes. This is because we've found that file-based routing is the most scalable and maintainable way to define your routes.

> [!TIP]
> Before you continue, it's important you have a good understanding of [code-based routing](./routing/code-based-routing.md) and [file-based routing](./routing/file-based-routing.md).

As mentioned in the beginning, TanStack Router was designed for complex applications that require a high degree of type-safety and maintainability. And to achieve this, the configuration of the router has been done in a precise way that allows TypeScript to infer the types of your routes as much as possible.

A key difference in the set-up of a _basic_ application with TanStack Router, is that your route configurations require a function to be provided to \`getParentRoute\`, that returns the parent route of the current route.

\`\`\`tsx
import { createRoute } from '@tanstack/react-router'
import { postsRoute } from './postsRoute'

export const postsIndexRoute = createRoute({
  getParentRoute: () => postsRoute,
  path: '/',
})
\`\`\`

At this stage, this is done so the definition of \`postsIndexRoute\` can be aware of its location in the route tree and so that it can correctly infer the types of the \`context\`, \`path params\`, \`search params\` returned by the parent route. Incorrectly defining the \`getParentRoute\` function means that the properties of the parent route will not be correctly inferred by the child route.

As such, this is a critical part of the route configuration and a point of failure if not done correctly.

But this is only one part of setting up a basic application. TanStack Router requires all the routes (including the root route) to be stitched into a **_route-tree_** so that it may be passed into the \`createRouter\` function before declaring the \`Router\` instance on the module for type inference. This is another critical part of the route configuration and a point of failure if not done correctly.

> 🤯 If this route-tree were in its own file for an application with ~40-50 routes, it can easily grow up to 700+ lines.

\`\`\`tsx
const routeTree = rootRoute.addChildren([
  postsRoute.addChildren([postsIndexRoute, postsIdRoute]),
])
\`\`\`

This complexity only increases as you begin to use more features of the router, such as nested context, loaders, search param validation, etc. As such, it no longer becomes feasible to define your routes in a single file. And so, users end up building their own _semi consistent_ way of defining their routes across multiple files. This can lead to inconsistencies and errors in the route configuration.

Finally, comes the issue of code-splitting. As your application grows, you'll want to code-split your components to reduce the initial bundle size of your application. This can be a bit of a headache to manage when you're defining your routes in a single file or even across multiple files.

\`\`\`tsx
import { createRoute, lazyRouteComponent } from '@tanstack/react-router'
import { postsRoute } from './postsRoute'

export const postsIndexRoute = createRoute({
  getParentRoute: () => postsRoute,
  path: '/',
  component: lazyRouteComponent(() => import('../page-components/posts/index')),
})
\`\`\`

All of this boilerplate, no matter how essential for providing a best-in-class type-inference experience, can be a bit overwhelming and can lead to inconsistencies and errors in the route configuration.

... and this example configuration is just for rendering a single codes-split route. Imagine having to do this for 40-50 routes. Now remember that you still haven't touched the \`context\`, \`loaders\`, \`search param validation\`, and other features of the router 🤕.

> So, why's file-based routing the preferred way?

TanStack Router's file-based routing is designed to solve all of these issues. It allows you to define your routes in a predictable way that is easy to manage and maintain, and is scalable as your application grows.

The file-based routing approach is powered by the TanStack Router Bundler Plugin. It performs 3 essential tasks that solve the pain points in route configuration when using code-based routing:

1. **Route configuration boilerplate**: It generates the boilerplate for your route configurations.
2. **Route tree stitching**: It stitches together your route configurations into a single cohesive route-tree. Also in the background, it correctly updates the route configurations to define the \`getParentRoute\` function match the routes with their parent routes.
3. **Code-splitting**: It automatically code-splits your route content components and updates the route configurations with the correct component. Additionally, at runtime, it ensures that the correct component is loaded when the route is visited.

Let's take a look at how the route configuration for the previous example would look like with file-based routing.

\`\`\`tsx
// src/routes/posts/index.ts
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/posts/')({
  component: () => 'Posts index component goes here!!!',
})
\`\`\`

That's it! No need to worry about defining the \`getParentRoute\` function, stitching together the route-tree, or code-splitting your components. The TanStack Router Bundler Plugin handles all of this for you.

At no point does the TanStack Router Bundler Plugin take away your control over your route configurations. It's designed to be as flexible as possible, allowing you to define your routes in a way that suits your application whilst reducing the boilerplate and complexity of the route configuration.

Check out the guides for [file-based routing](./routing/file-based-routing.md) and [code-splitting](./guide/code-splitting.md) for a more in-depth explanation of how they work in TanStack Router.

# Devtools

> Link, take this sword... I mean Devtools!... to help you on your way!

Wave your hands in the air and shout hooray because TanStack Router comes with dedicated devtools! 🥳

When you begin your TanStack Router journey, you'll want these devtools by your side. They help visualize all of the inner workings of TanStack Router and will likely save you hours of debugging if you find yourself in a pinch!

## Installation

The devtools are a separate package that you need to install:

\`\`\`sh
npm install @tanstack/react-router-devtools
\`\`\`

or

\`\`\`sh
pnpm add @tanstack/react-router-devtools
\`\`\`

or

\`\`\`sh
yarn add @tanstack/react-router-devtools
\`\`\`

or

\`\`\`sh
bun add @tanstack/react-router-devtools
\`\`\`

## Import the Devtools

\`\`\`js
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
\`\`\`

## Using Devtools in production

The Devtools, if imported as \`TanStackRouterDevtools\` will not be shown in production. If you want to have devtools in an environment with \`process.env.NODE_ENV === 'production'\`, use instead \`TanStackRouterDevtoolsInProd\`, which has all the same options:

\`\`\`tsx
import { TanStackRouterDevtoolsInProd } from '@tanstack/react-router-devtools'
\`\`\`

## Using inside of the \`RouterProvider\`

The easiest way for the devtools to work is to render them inside of your root route (or any other route). This will automatically connect the devtools to the router instance.

\`\`\`tsx
const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
})

const routeTree = rootRoute.addChildren([
  // ... other routes
])

const router = createRouter({
  routeTree,
})

function App() {
  return <RouterProvider router={router} />
}
\`\`\`

## Manually passing the Router Instance

If rendering the devtools inside of the \`RouterProvider\` isn't your cup of tea, a \`router\` prop for the devtools accepts the same \`router\` instance you pass to the \`Router\` component. This makes it possible to place the devtools anywhere on the page, not just inside the provider:

\`\`\`tsx
function App() {
  return (
    <>
      <RouterProvider router={router} />
      <TanStackRouterDevtools router={router} />
    </>
  )
}
\`\`\`

## Floating Mode

Floating Mode will mount the devtools as a fixed, floating element in your app and provide a toggle in the corner of the screen to show and hide the devtools. This toggle state will be stored and remembered in localStorage across reloads.

Place the following code as high in your React app as you can. The closer it is to the root of the page, the better it will work!

\`\`\`js
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

function App() {
  return (
    <>
      <Router />
      <TanStackRouterDevtools initialIsOpen={false} />
    </>
  )
}
\`\`\`

### Devtools Options

- \`router: Router\`
  - The router instance to connect to.
- \`initialIsOpen: Boolean\`
  - Set this \`true\` if you want the devtools to default to being open.
- \`panelProps: PropsObject\`
  - Use this to add props to the panel. For example, you can add \`className\`, \`style\` (merge and override default style), etc.
- \`closeButtonProps: PropsObject\`
  - Use this to add props to the close button. For example, you can add \`className\`, \`style\` (merge and override default style), \`onClick\` (extend default handler), etc.
- \`toggleButtonProps: PropsObject\`
  - Use this to add props to the toggle button. For example, you can add \`className\`, \`style\` (merge and override default style), \`onClick\` (extend default handler), etc.
- \`position?: "top-left" | "top-right" | "bottom-left" | "bottom-right"\`
  - Defaults to \`bottom-left\`.
  - The position of the TanStack Router logo to open and close the devtools panel.
- \`shadowDOMTarget?: ShadowRoot\`
  - Specifies a Shadow DOM target for the devtools.
  - By default, devtool styles are applied to the \`<head>\` tag of the main document (light DOM). When a \`shadowDOMTarget\` is provided, styles will be applied within this Shadow DOM instead.
- \`containerElement?: string | any\`
  - Use this to render the devtools inside a different type of container element for ally purposes.
  - Any string which corresponds to a valid intrinsic JSX element is allowed.
  - Defaults to 'footer'.

## Fixed Mode

To control the position of the devtools, import the \`TanStackRouterDevtoolsPanel\`:

\`\`\`js
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
\`\`\`

It can then be attached to provided shadow DOM target:

\`\`\`js
<TanStackRouterDevtoolsPanel
  shadowDOMTarget={shadowContainer}
  router={router}
/>
\`\`\`

Click [here](https://tanstack.com/router/latest/docs/framework/react/examples/basic-devtools-panel) to see a live example of this in StackBlitz.

## Embedded Mode

Embedded Mode will embed the devtools as a regular component in your application. You can style it however you'd like after that!

\`\`\`js
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'

function App() {
  return (
    <>
      <Router router={router} />
      <TanStackRouterDevtoolsPanel
        router={router}
        style={styles}
        className={className}
      />
    </>
  )
}
\`\`\`

### DevtoolsPanel Options

- \`router: Router\`
  - The router instance to connect to.
- \`style: StyleObject\`
  - The standard React style object used to style a component with inline styles.
- \`className: string\`
  - The standard React className property used to style a component with classes.
- \`isOpen?: boolean\`
  - A boolean variable indicating whether the panel is open or closed.
- \`setIsOpen?: (isOpen: boolean) => void\`
  - A function that toggles the open and close state of the panel.
- \`handleDragStart?: (e: any) => void\`
  - Handles the opening and closing the devtools panel.
- \`shadowDOMTarget?: ShadowRoot\`
  - Specifies a Shadow DOM target for the devtools.
  - By default, devtool styles are applied to the \`<head>\` tag of the main document (light DOM). When a \`shadowDOMTarget\` is provided, styles will be applied within this Shadow DOM instead.

# Frequently Asked Questions

Welcome to the TanStack Router FAQ! Here you'll find answers to common questions about the TanStack Router. If you have a question that isn't answered here, please feel free to ask in the [TanStack Discord](https://tlinz.com/discord).

## Why should you choose TanStack Router over another router?

To answer this question, it's important to view the other options in the space. There are many alternatives to choose from, but only a couple that are widely adopted and actively maintained:

- **Next.js** - Widely regarded as the leading framework for starting new React projects. Its design focuses on performance, development workflows, and cutting-edge technology. The framework's APIs and abstractions, while powerful, can sometimes present as non-standard. Rapid growth and industry adoption have resulted in a feature-rich experience, sometimes leading to a steeper learning curve and increased overhead.
- **Remix / React Router** - Based on the historically successful React Router, Remix delivers a powerful developer and user experience. Its API and architectural vision are firmly rooted in web standards such as Request/Response, with an emphasis on adaptability across various JavaScript environments. Many of its APIs and abstractions are well-designed and have influenced more than a few of TanStack Router's APIs. However, its rigid design, the integration of type safety as an add-on, and sometimes strict adherence to platform APIs can present limitations for some developers.

These frameworks and routers have their strengths, but they also come with trade-offs that may not align with every project's needs. TanStack Router aims to strike a balance by offering routing APIs designed to improve the developer experience without sacrificing flexibility or performance.

## Is TanStack Router a framework?

TanStack Router itself is not a "framework" in the traditional sense, since it doesn't address a few other common full-stack concerns. However, TanStack Router has been designed to be upgradable to a full-stack framework when used in conjunction with other tools that address bundling, deployments, and server-side-specific functionality. This is why we are currently developing [TanStack Start](https://tanstack.com/start), a full-stack framework that is built on top of TanStack Router and Vite.
For a deeper dive on the history of TanStack Router, feel free to read [TanStack Router's History](./decisions-on-dx.md#tanstack-routers-origin-story).

## Should I commit my \`routeTree.gen.ts\` file into git?

Yes! Although the route tree file (i.e., \`routeTree.gen.ts\`) is generated by TanStack Router, it is essentially part of your application’s runtime, not a build artifact. The route tree file is a critical part of your application’s source code, and it is used by TanStack Router to build your application’s routes at runtime.

You should commit this file into git so that other developers can use it to build your application.

## Can I conditionally render the Root Route component?

No, the root route is always rendered as it is the entry point of your application.

If you need to conditionally render a route's component, this usually means that the page content needs to be different based on some condition (e.g. user authentication). For this use case, you should use a [Layout Route](./routing/routing-concepts.md#layout-routes) or a [Pathless Layout Route](./routing/routing-concepts.md#pathless-layout-routes) to conditionally render the content.

You can restrict access to these routes using a conditional check in the \`beforeLoad\` function of the route.

<details>
<summary>What does this look like?</summary>

\`\`\`tsx
// src/routes/_pathless-layout.tsx
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { isAuthenticated } from '../utils/auth'

export const Route = createFileRoute('/_pathless-layout', {
  beforeLoad: async () => {
    // Check if the user is authenticated
    const authed = await isAuthenticated()
    if (!authed) {
      // Redirect the user to the login page
      return '/login'
    }
  },
  component: PathlessLayoutRouteComponent,
  // ...
})

function PathlessLayoutRouteComponent() {
  return (
    <div>
      <h1>You are authed</h1>
      <Outlet />
    </div>
  )
}
\`\`\`

</details>

`;
