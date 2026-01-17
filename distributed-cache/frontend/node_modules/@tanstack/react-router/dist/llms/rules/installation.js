export default `# Manual Setup

To set up TanStack Router manually in a React project, follow the steps below. This gives you a bare minimum setup to get going with TanStack Router using both file-based route generation and code-based route configuration:

## Using File-Based Route Generation

#### Install TanStack Router, Vite Plugin, and the Router Devtools

\`\`\`sh
npm install @tanstack/react-router @tanstack/react-router-devtools
npm install -D @tanstack/router-plugin
# or
pnpm add @tanstack/react-router @tanstack/react-router-devtools
pnpm add -D @tanstack/router-plugin
# or
yarn add @tanstack/react-router @tanstack/react-router-devtools
yarn add -D @tanstack/router-plugin
# or
bun add @tanstack/react-router @tanstack/react-router-devtools
bun add -D @tanstack/router-plugin
# or
deno add npm:@tanstack/react-router npm:@tanstack/router-plugin npm:@tanstack/react-router-devtools
\`\`\`

#### Configure the Vite Plugin

\`\`\`tsx
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // Please make sure that '@tanstack/router-plugin' is passed before '@vitejs/plugin-react'
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    // ...,
  ],
})
\`\`\`

> [!TIP]
> If you are not using Vite, or any of the supported bundlers, you can check out the [TanStack Router CLI](./with-router-cli) guide for more info.

Create the following files:

- \`src/routes/__root.tsx\` (with two '\`_\`' characters)
- \`src/routes/index.tsx\`
- \`src/routes/about.tsx\`
- \`src/main.tsx\`

#### \`src/routes/__root.tsx\`

\`\`\`tsx
import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

const RootLayout = () => (
  <>
    <div className="p-2 flex gap-2">
      <Link to="/" className="[&.active]:font-bold">
        Home
      </Link>{' '}
      <Link to="/about" className="[&.active]:font-bold">
        About
      </Link>
    </div>
    <hr />
    <Outlet />
    <TanStackRouterDevtools />
  </>
)

export const Route = createRootRoute({ component: RootLayout })
\`\`\`

#### \`src/routes/index.tsx\`

\`\`\`tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Index,
})

function Index() {
  return (
    <div className="p-2">
      <h3>Welcome Home!</h3>
    </div>
  )
}
\`\`\`

#### \`src/routes/about.tsx\`

\`\`\`tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return <div className="p-2">Hello from About!</div>
}
\`\`\`

#### \`src/main.tsx\`

Regardless of whether you are using the \`@tanstack/router-plugin\` package and running the \`npm run dev\`/\`npm run build\` scripts, or manually running the \`tsr watch\`/\`tsr generate\` commands from your package scripts, the route tree file will be generated at \`src/routeTree.gen.ts\`.

Import the generated route tree and create a new router instance:

\`\`\`tsx
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'

// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Create a new router instance
const router = createRouter({ routeTree })

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Render the app
const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}
\`\`\`

If you are working with this pattern you should change the \`id\` of the root \`<div>\` on your \`index.html\` file to \`<div id='root'></div>\`

## Using Code-Based Route Configuration

> [!IMPORTANT]
> The following example shows how to configure routes using code, and for simplicity's sake is in a single file for this demo. While code-based generation allows you to declare many routes and even the router instance in a single file, we recommend splitting your routes into separate files for better organization and performance as your application grows.

\`\`\`tsx
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  Link,
  createRouter,
  createRoute,
  createRootRoute,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

const rootRoute = createRootRoute({
  component: () => (
    <>
      <div className="p-2 flex gap-2">
        <Link to="/" className="[&.active]:font-bold">
          Home
        </Link>{' '}
        <Link to="/about" className="[&.active]:font-bold">
          About
        </Link>
      </div>
      <hr />
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: function Index() {
    return (
      <div className="p-2">
        <h3>Welcome Home!</h3>
      </div>
    )
  },
})

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/about',
  component: function About() {
    return <div className="p-2">Hello from About!</div>
  },
})

const routeTree = rootRoute.addChildren([indexRoute, aboutRoute])

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('app')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}
\`\`\`

If you glossed over these examples or didn't understand something, we don't blame you, because there's so much more to learn to really take advantage of TanStack Router! Let's move on.

# Migration from React Location

Before you begin your journey in migrating from React Location, it's important that you have a good understanding of the [Routing Concepts](../routing/routing-concepts.md) and [Design Decisions](../decisions-on-dx.md) used by TanStack Router.

## Differences between React Location and TanStack Router

React Location and TanStack Router share much of same design decisions concepts, but there are some key differences that you should be aware of.

- React Location uses _generics_ to infer types for routes, while TanStack Router uses _module declaration merging_ to infer types.
- Route configuration in React Location is done using a single array of route definitions, while in TanStack Router, route configuration is done using a tree of route definitions starting with the [root route](../routing/routing-concepts.md#the-root-route).
- [File-based routing](../routing/file-based-routing.md) is the recommended way to define routes in TanStack Router, while React Location only allows you to define routes in a single file using a code-based approach.
  - TanStack Router does support a [code-based approach](../routing/code-based-routing.md) to defining routes, but it is not recommended for most use cases. You can read more about why, over here: [why is file-based routing the preferred way to define routes?](../decisions-on-dx.md#why-is-file-based-routing-the-preferred-way-to-define-routes)

## Migration guide

In this guide we'll go over the process of migrating the [React Location Basic example](https://github.com/TanStack/router/tree/react-location/examples/basic) over to TanStack Router using file-based routing, with the end goal of having the same functionality as the original example (styling and other non-routing related code will be omitted).

> [!TIP]
> To use a code-based approach for defining your routes, you can read the [code-based Routing](../routing/code-based-routing.md) guide.

### Step 1: Swap over to TanStack Router's dependencies

First, we need to install the dependencies for TanStack Router. For detailed installation instructions, see our [How to Install TanStack Router](../how-to/install.md) guide.

\`\`\`sh
npm install @tanstack/react-router @tanstack/router-devtools
\`\`\`

And remove the React Location dependencies.

\`\`\`sh
npm uninstall @tanstack/react-location @tanstack/react-location-devtools
\`\`\`

### Step 2: Use the file-based routing watcher

If your project uses Vite (or one of the supported bundlers), you can use the TanStack Router plugin to watch for changes in your routes files and automatically update the routes configuration.

Installation of the Vite plugin:

\`\`\`sh
npm install -D @tanstack/router-plugin
\`\`\`

And add it to your \`vite.config.js\`:

\`\`\`js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

export default defineConfig({
  // ...
  plugins: [tanstackRouter(), react()],
})
\`\`\`

However, if your application does not use Vite, you use one of our other [supported bundlers](../routing/file-based-routing.md#getting-started-with-file-based-routing), or you can use the \`@tanstack/router-cli\` package to watch for changes in your routes files and automatically update the routes configuration.

### Step 3: Add the file-based configuration file to your project

Create a \`tsr.config.json\` file in the root of your project with the following content:

\`\`\`json
{
  "routesDirectory": "./src/routes",
  "generatedRouteTree": "./src/routeTree.gen.ts"
}
\`\`\`

You can find the full list of options for the \`tsr.config.json\` file [here](../routing/file-based-routing.md).

### Step 4: Create the routes directory

Create a \`routes\` directory in the \`src\` directory of your project.

\`\`\`sh
mkdir src/routes
\`\`\`

### Step 5: Create the root route file

\`\`\`tsx
// src/routes/__root.tsx
import { createRootRoute, Outlet, Link } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'

export const Route = createRootRoute({
  component: () => {
    return (
      <>
        <div>
          <Link to="/" activeOptions={{ exact: true }}>
            Home
          </Link>
          <Link to="/posts">Posts</Link>
        </div>
        <hr />
        <Outlet />
        <TanStackRouterDevtools />
      </>
    )
  },
})
\`\`\`

### Step 6: Create the index route file

\`\`\`tsx
// src/routes/index.tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Index,
})
\`\`\`

> You will need to move any related components and logic needed for the index route from the \`src/index.tsx\` file to the \`src/routes/index.tsx\` file.

### Step 7: Create the posts route file

\`\`\`tsx
// src/routes/posts.tsx
import { createFileRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/posts')({
  component: Posts,
  loader: async () => {
    const posts = await fetchPosts()
    return {
      posts,
    }
  },
})

function Posts() {
  const { posts } = Route.useLoaderData()
  return (
    <div>
      <nav>
        {posts.map((post) => (
          <Link
            key={post.id}
            to={\`/posts/$postId\`}
            params={{ postId: post.id }}
          >
            {post.title}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
\`\`\`

> You will need to move any related components and logic needed for the posts route from the \`src/index.tsx\` file to the \`src/routes/posts.tsx\` file.

### Step 8: Create the posts index route file

\`\`\`tsx
// src/routes/posts.index.tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/posts/')({
  component: PostsIndex,
})
\`\`\`

> You will need to move any related components and logic needed for the posts index route from the \`src/index.tsx\` file to the \`src/routes/posts.index.tsx\` file.

### Step 9: Create the posts id route file

\`\`\`tsx
// src/routes/posts.$postId.tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/posts/$postId')({
  component: PostsId,
  loader: async ({ params: { postId } }) => {
    const post = await fetchPost(postId)
    return {
      post,
    }
  },
})

function PostsId() {
  const { post } = Route.useLoaderData()
  // ...
}
\`\`\`

> You will need to move any related components and logic needed for the posts id route from the \`src/index.tsx\` file to the \`src/routes/posts.$postId.tsx\` file.

### Step 10: Generate the route tree

If you are using one of the supported bundlers, the route tree will be generated automatically when you run the dev script.

If you are not using one of the supported bundlers, you can generate the route tree by running the following command:

\`\`\`sh
npx tsr generate
\`\`\`

### Step 11: Update the main entry file to render the Router

Once you've generated the route-tree, you can then update the \`src/index.tsx\` file to create the router instance and render it.

\`\`\`tsx
// src/index.tsx
import React from 'react'
import ReactDOM from 'react-dom'
import { createRouter, RouterProvider } from '@tanstack/react-router'

// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Create a new router instance
const router = createRouter({ routeTree })

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const domElementId = 'root' // Assuming you have a root element with the id 'root'

// Render the app
const rootElement = document.getElementById(domElementId)
if (!rootElement) {
  throw new Error(\`Element with id \${domElementId} not found\`)
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
\`\`\`

### Finished!

You should now have successfully migrated your application from React Location to TanStack Router using file-based routing.

React Location also has a few more features that you might be using in your application. Here are some guides to help you migrate those features:

- [Search params](../guide/search-params.md)
- [Data loading](../guide/data-loading.md)
- [History types](../guide/history-types.md)
- [Wildcard / Splat / Catch-all routes](../routing/routing-concepts.md#splat--catch-all-routes)
- [Authenticated routes](../guide/authenticated-routes.md)

TanStack Router also has a few more features that you might want to explore:

- [Router Context](../guide/router-context.md)
- [Preloading](../guide/preloading.md)
- [Pathless Layout Routes](../routing/routing-concepts.md#pathless-layout-routes)
- [Route masking](../guide/route-masking.md)
- [SSR](../guide/ssr.md)
- ... and more!

If you are facing any issues or have any questions, feel free to ask for help in the TanStack Discord.

# Migration from React Router Checklist

**_If your UI is blank, open the console, and you will probably have some errors that read something along the lines of \`cannot use 'useNavigate' outside of context\` . This means there are React Router api’s that are still imported and referenced that you need to find and remove. The easiest way to make sure you find all React Router imports is to uninstall \`react-router-dom\` and then you should get typescript errors in your files. Then you will know what to change to a \`@tanstack/react-router\` import._**

Here is the [example repo](https://github.com/Benanna2019/SickFitsForEveryone/tree/migrate-to-tanstack/router/React-Router)

- [ ] Install Router - \`npm i @tanstack/react-router\` (see [detailed installation guide](../how-to/install.md))
- [ ] **Optional:** Uninstall React Router to get TypeScript errors on imports.
  - At this point I don’t know if you can do a gradual migration, but it seems likely you could have multiple router providers, not desirable.
  - The api’s between React Router and TanStack Router are very similar and could most likely be handled in a sprint cycle or two if that is your companies way of doing things.
- [ ] Create Routes for each existing React Router route we have
- [ ] Create root route
- [ ] Create router instance
- [ ] Add global module in main.tsx
- [ ] Remove any React Router (\`createBrowserRouter\` or \`BrowserRouter\`), \`Routes\`, and \`Route\` Components from main.tsx
- [ ] **Optional:** Refactor \`render\` function for custom setup/providers - The repo referenced above has an example - This was necessary in the case of Supertokens. Supertoken has a specific setup with React Router and a different setup with all other React implementations
- [ ] Set RouterProvider and pass it the router as the prop
- [ ] Replace all instances of React Router \`Link\` component with \`@tanstack/react-router\` \`Link\` component
  - [ ] Add \`to\` prop with literal path
  - [ ] Add \`params\` prop, where necessary with params like so \`params={{ orderId: order.id }}\`
- [ ] Replace all instances of React Router \`useNavigate\` hook with \`@tanstack/react-router\` \`useNavigate\` hook
  - [ ] Set \`to\` property and \`params\` property where needed
- [ ] Replace any React Router \`Outlet\`'s with the \`@tanstack/react-router\` equivalent
- [ ] If you are using \`useSearchParams\` hook from React Router, move the search params default value to the validateSearch property on a Route definition.
  - [ ] Instead of using the \`useSearchParams\` hook, use \`@tanstack/react-router\` \`Link\`'s search property to update the search params state
  - [ ] To read search params you can do something like the following
    - \`const { page } = useSearch({ from: productPage.fullPath })\`
- [ ] If using React Router’s \`useParams\` hook, update the import to be from \`@tanstack/react-router\` and set the \`from\` property to the literal path name where you want to read the params object from
  - So say we have a route with the path name \`orders/$orderid\`.
  - In the \`useParams\` hook we would set up our hook like so: \`const params = useParams({ from: "/orders/$orderId" })\`
  - Then wherever we wanted to access the order id we would get it off of the params object \`params.orderId\`

# Installation with Esbuild

[//]: # 'BundlerConfiguration'

To use file-based routing with **Esbuild**, you'll need to install the \`@tanstack/router-plugin\` package.

\`\`\`sh
npm install -D @tanstack/router-plugin
\`\`\`

Once installed, you'll need to add the plugin to your configuration.

\`\`\`tsx
// esbuild.config.js
import { tanstackRouter } from '@tanstack/router-plugin/esbuild'

export default {
  // ...
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
  ],
}
\`\`\`

Or, you can clone our [Quickstart Esbuild example](https://github.com/TanStack/router/tree/main/examples/react/quickstart-esbuild-file-based) and get started.

Now that you've added the plugin to your Esbuild configuration, you're all set to start using file-based routing with TanStack Router.

[//]: # 'BundlerConfiguration'

## Ignoring the generated route tree file

If your project is configured to use a linter and/or formatter, you may want to ignore the generated route tree file. This file is managed by TanStack Router and therefore shouldn't be changed by your linter or formatter.

Here are some resources to help you ignore the generated route tree file:

- Prettier - [https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore](https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore)
- ESLint - [https://eslint.org/docs/latest/use/configure/ignore#ignoring-files](https://eslint.org/docs/latest/use/configure/ignore#ignoring-files)
- Biome - [https://biomejs.dev/reference/configuration/#filesignore](https://biomejs.dev/reference/configuration/#filesignore)

> [!WARNING]
> If you are using VSCode, you may experience the route tree file unexpectedly open (with errors) after renaming a route.

You can prevent that from the VSCode settings by marking the file as readonly. Our recommendation is to also exclude it from search results and file watcher with the following settings:

\`\`\`json
{
  "files.readonlyInclude": {
    "**/routeTree.gen.ts": true
  },
  "files.watcherExclude": {
    "**/routeTree.gen.ts": true
  },
  "search.exclude": {
    "**/routeTree.gen.ts": true
  }
}
\`\`\`

You can use those settings either at a user level or only for a single workspace by creating the file \`.vscode/settings.json\` at the root of your project.

## Configuration

When using the TanStack Router Plugin with Esbuild for File-based routing, it comes with some sane defaults that should work for most projects:

\`\`\`json
{
  "routesDirectory": "./src/routes",
  "generatedRouteTree": "./src/routeTree.gen.ts",
  "routeFileIgnorePrefix": "-",
  "quoteStyle": "single"
}
\`\`\`

If these defaults work for your project, you don't need to configure anything at all! However, if you need to customize the configuration, you can do so by editing the configuration object passed into the \`tanstackRouter\` function.

You can find all the available configuration options in the [File-based Routing API Reference](../../../api/file-based-routing.md).

# Installation with Router CLI

> [!WARNING]
> You should only use the TanStack Router CLI if you are not using a supported bundler. The CLI only supports the generation of the route tree file and does not provide any other features.

To use file-based routing with the TanStack Router CLI, you'll need to install the \`@tanstack/router-cli\` package.

\`\`\`sh
npm install -D @tanstack/router-cli
\`\`\`

Once installed, you'll need to amend your scripts in your \`package.json\` for the CLI to \`watch\` and \`generate\` files.

\`\`\`json
{
  "scripts": {
    "generate-routes": "tsr generate",
    "watch-routes": "tsr watch",
    "build": "npm run generate-routes && ...",
    "dev": "npm run watch-routes && ..."
  }
}
\`\`\`

[//]: # 'AfterScripts'
[//]: # 'AfterScripts'

You shouldn't forget to _ignore_ the generated route tree file. Head over to the [Ignoring the generated route tree file](#ignoring-the-generated-route-tree-file) section to learn more.

With the CLI installed, the following commands are made available via the \`tsr\` command

## Using the \`generate\` command

Generates the routes for a project based on the provided configuration.

\`\`\`sh
tsr generate
\`\`\`

## Using the \`watch\` command

Continuously watches the specified directories and regenerates routes as needed.

**Usage:**

\`\`\`sh
tsr watch
\`\`\`

With file-based routing enabled, whenever you start your application in development mode, TanStack Router will watch your configured \`routesDirectory\` and generate your route tree whenever a file is added, removed, or changed.

## Ignoring the generated route tree file

If your project is configured to use a linter and/or formatter, you may want to ignore the generated route tree file. This file is managed by TanStack Router and therefore shouldn't be changed by your linter or formatter.

Here are some resources to help you ignore the generated route tree file:

- Prettier - [https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore](https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore)
- ESLint - [https://eslint.org/docs/latest/use/configure/ignore#ignoring-files](https://eslint.org/docs/latest/use/configure/ignore#ignoring-files)
- Biome - [https://biomejs.dev/reference/configuration/#filesignore](https://biomejs.dev/reference/configuration/#filesignore)

> [!WARNING]
> If you are using VSCode, you may experience the route tree file unexpectedly open (with errors) after renaming a route.

You can prevent that from the VSCode settings by marking the file as readonly. Our recommendation is to also exclude it from search results and file watcher with the following settings:

\`\`\`json
{
  "files.readonlyInclude": {
    "**/routeTree.gen.ts": true
  },
  "files.watcherExclude": {
    "**/routeTree.gen.ts": true
  },
  "search.exclude": {
    "**/routeTree.gen.ts": true
  }
}
\`\`\`

You can use those settings either at a user level or only for a single workspace by creating the file \`.vscode/settings.json\` at the root of your project.

## Configuration

When using the TanStack Router CLI for File-based routing, it comes with some sane defaults that should work for most projects:

\`\`\`json
{
  "routesDirectory": "./src/routes",
  "generatedRouteTree": "./src/routeTree.gen.ts",
  "routeFileIgnorePrefix": "-",
  "quoteStyle": "single"
}
\`\`\`

If these defaults work for your project, you don't need to configure anything at all! However, if you need to customize the configuration, you can do so by creating a \`tsr.config.json\` file in the root of your project directory.

[//]: # 'TargetConfiguration'
[//]: # 'TargetConfiguration'

You can find all the available configuration options in the [File-based Routing API Reference](../../../api/file-based-routing.md).

# Installation with Rspack

[//]: # 'BundlerConfiguration'

To use file-based routing with **Rspack** or **Rsbuild**, you'll need to install the \`@tanstack/router-plugin\` package.

\`\`\`sh
npm install -D @tanstack/router-plugin
\`\`\`

Once installed, you'll need to add the plugin to your configuration.

\`\`\`tsx
// rsbuild.config.ts
import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/rspack'

export default defineConfig({
  plugins: [pluginReact()],
  tools: {
    rspack: {
      plugins: [
        tanstackRouter({
          target: 'react',
          autoCodeSplitting: true,
        }),
      ],
    },
  },
})
\`\`\`

Or, you can clone our [Quickstart Rspack/Rsbuild example](https://github.com/TanStack/router/tree/main/examples/react/quickstart-rspack-file-based) and get started.

Now that you've added the plugin to your Rspack/Rsbuild configuration, you're all set to start using file-based routing with TanStack Router.

[//]: # 'BundlerConfiguration'

## Ignoring the generated route tree file

If your project is configured to use a linter and/or formatter, you may want to ignore the generated route tree file. This file is managed by TanStack Router and therefore shouldn't be changed by your linter or formatter.

Here are some resources to help you ignore the generated route tree file:

- Prettier - [https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore](https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore)
- ESLint - [https://eslint.org/docs/latest/use/configure/ignore#ignoring-files](https://eslint.org/docs/latest/use/configure/ignore#ignoring-files)
- Biome - [https://biomejs.dev/reference/configuration/#filesignore](https://biomejs.dev/reference/configuration/#filesignore)

> [!WARNING]
> If you are using VSCode, you may experience the route tree file unexpectedly open (with errors) after renaming a route.

You can prevent that from the VSCode settings by marking the file as readonly. Our recommendation is to also exclude it from search results and file watcher with the following settings:

\`\`\`json
{
  "files.readonlyInclude": {
    "**/routeTree.gen.ts": true
  },
  "files.watcherExclude": {
    "**/routeTree.gen.ts": true
  },
  "search.exclude": {
    "**/routeTree.gen.ts": true
  }
}
\`\`\`

You can use those settings either at a user level or only for a single workspace by creating the file \`.vscode/settings.json\` at the root of your project.

## Configuration

When using the TanStack Router Plugin with Rspack (or Rsbuild) for File-based routing, it comes with some sane defaults that should work for most projects:

\`\`\`json
{
  "routesDirectory": "./src/routes",
  "generatedRouteTree": "./src/routeTree.gen.ts",
  "routeFileIgnorePrefix": "-",
  "quoteStyle": "single"
}
\`\`\`

If these defaults work for your project, you don't need to configure anything at all! However, if you need to customize the configuration, you can do so by editing the configuration object passed into the \`tanstackRouter\` function.

You can find all the available configuration options in the [File-based Routing API Reference](../../../api/file-based-routing.md).

# Installation with Vite

[//]: # 'BundlerConfiguration'

To use file-based routing with **Vite**, you'll need to install the \`@tanstack/router-plugin\` package.

\`\`\`sh
npm install -D @tanstack/router-plugin
\`\`\`

Once installed, you'll need to add the plugin to your Vite configuration.

\`\`\`ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // Please make sure that '@tanstack/router-plugin' is passed before '@vitejs/plugin-react'
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    // ...
  ],
})
\`\`\`

Or, you can clone our [Quickstart Vite example](https://github.com/TanStack/router/tree/main/examples/react/quickstart-file-based) and get started.

> [!WARNING]
> If you are using the older \`@tanstack/router-vite-plugin\` package, you can still continue to use it, as it will be aliased to the \`@tanstack/router-plugin/vite\` package. However, we would recommend using the \`@tanstack/router-plugin\` package directly.

Now that you've added the plugin to your Vite configuration, you're all set to start using file-based routing with TanStack Router.

[//]: # 'BundlerConfiguration'

## Ignoring the generated route tree file

If your project is configured to use a linter and/or formatter, you may want to ignore the generated route tree file. This file is managed by TanStack Router and therefore shouldn't be changed by your linter or formatter.

Here are some resources to help you ignore the generated route tree file:

- Prettier - [https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore](https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore)
- ESLint - [https://eslint.org/docs/latest/use/configure/ignore#ignoring-files](https://eslint.org/docs/latest/use/configure/ignore#ignoring-files)
- Biome - [https://biomejs.dev/reference/configuration/#filesignore](https://biomejs.dev/reference/configuration/#filesignore)

> [!WARNING]
> If you are using VSCode, you may experience the route tree file unexpectedly open (with errors) after renaming a route.

You can prevent that from the VSCode settings by marking the file as readonly. Our recommendation is to also exclude it from search results and file watcher with the following settings:

\`\`\`json
{
  "files.readonlyInclude": {
    "**/routeTree.gen.ts": true
  },
  "files.watcherExclude": {
    "**/routeTree.gen.ts": true
  },
  "search.exclude": {
    "**/routeTree.gen.ts": true
  }
}
\`\`\`

You can use those settings either at a user level or only for a single workspace by creating the file \`.vscode/settings.json\` at the root of your project.

## Configuration

When using the TanStack Router Plugin with Vite for File-based routing, it comes with some sane defaults that should work for most projects:

\`\`\`json
{
  "routesDirectory": "./src/routes",
  "generatedRouteTree": "./src/routeTree.gen.ts",
  "routeFileIgnorePrefix": "-",
  "quoteStyle": "single"
}
\`\`\`

If these defaults work for your project, you don't need to configure anything at all! However, if you need to customize the configuration, you can do so by editing the configuration object passed into the \`tanstackRouter\` function.

You can find all the available configuration options in the [File-based Routing API Reference](../../../api/file-based-routing.md).

# Installation with Webpack

[//]: # 'BundlerConfiguration'

To use file-based routing with **Webpack**, you'll need to install the \`@tanstack/router-plugin\` package.

\`\`\`sh
npm install -D @tanstack/router-plugin
\`\`\`

Once installed, you'll need to add the plugin to your configuration.

\`\`\`tsx
// webpack.config.ts
import { tanstackRouter } from '@tanstack/router-plugin/webpack'

export default {
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
  ],
}
\`\`\`

Or, you can clone our [Quickstart Webpack example](https://github.com/TanStack/router/tree/main/examples/react/quickstart-webpack-file-based) and get started.

Now that you've added the plugin to your Webpack configuration, you're all set to start using file-based routing with TanStack Router.

[//]: # 'BundlerConfiguration'

## Ignoring the generated route tree file

If your project is configured to use a linter and/or formatter, you may want to ignore the generated route tree file. This file is managed by TanStack Router and therefore shouldn't be changed by your linter or formatter.

Here are some resources to help you ignore the generated route tree file:

- Prettier - [https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore](https://prettier.io/docs/en/ignore.html#ignoring-files-prettierignore)
- ESLint - [https://eslint.org/docs/latest/use/configure/ignore#ignoring-files](https://eslint.org/docs/latest/use/configure/ignore#ignoring-files)
- Biome - [https://biomejs.dev/reference/configuration/#filesignore](https://biomejs.dev/reference/configuration/#filesignore)

> [!WARNING]
> If you are using VSCode, you may experience the route tree file unexpectedly open (with errors) after renaming a route.

You can prevent that from the VSCode settings by marking the file as readonly. Our recommendation is to also exclude it from search results and file watcher with the following settings:

\`\`\`json
{
  "files.readonlyInclude": {
    "**/routeTree.gen.ts": true
  },
  "files.watcherExclude": {
    "**/routeTree.gen.ts": true
  },
  "search.exclude": {
    "**/routeTree.gen.ts": true
  }
}
\`\`\`

You can use those settings either at a user level or only for a single workspace by creating the file \`.vscode/settings.json\` at the root of your project.

## Configuration

When using the TanStack Router Plugin with Webpack for File-based routing, it comes with some sane defaults that should work for most projects:

\`\`\`json
{
  "routesDirectory": "./src/routes",
  "generatedRouteTree": "./src/routeTree.gen.ts",
  "routeFileIgnorePrefix": "-",
  "quoteStyle": "single"
}
\`\`\`

If these defaults work for your project, you don't need to configure anything at all! However, if you need to customize the configuration, you can do so by editing the configuration object passed into the \`tanstackRouter\` function.

You can find all the available configuration options in the [File-based Routing API Reference](../../../api/file-based-routing.md).

`;
