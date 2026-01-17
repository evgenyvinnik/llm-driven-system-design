# 20 Forms, 40 Designs

A form library comparison playground demonstrating 20 common forms implemented across 41 React design systems with complete CSS isolation using an iframe-based architecture.

**Live Demo:** [evgenyvinnik.github.io/20forms-20designs](https://evgenyvinnik.github.io/20forms-20designs/)

**Source Code:** [github.com/evgenyvinnik/20forms-20designs](https://github.com/evgenyvinnik/20forms-20designs)

## Features

- **820 Form Implementations** - 41 libraries × 20 forms, each in an isolated context
- **CSS Isolation** - No style conflicts between design systems (iframe-based architecture)
- **Theme Support** - Light/dark mode toggle for libraries that support theming
- **Comparison Matrix** - Side-by-side comparison of forms across libraries
- **Static Deployment** - Fully static, hosted on GitHub Pages

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Shell Application                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │           Comparison Matrix UI (React + Vite)            │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │    │
│  │  │ Form Select │  │ Lib Select  │  │ Theme Toggle│       │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│  ┌───────────────────────────▼───────────────────────────────┐  │
│  │                    Preview Grid                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │  │
│  │  │ <iframe> │  │ <iframe> │  │ <iframe> │  │ <iframe> │   │  │
│  │  │  MUI     │  │  Chakra  │  │  Ant     │  │  ...     │   │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                    ▼                ▼                ▼
        ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
        │   MUI App     │  │  Chakra App   │  │   Ant App     │
        │ (20 forms)    │  │ (20 forms)    │  │ (20 forms)    │
        │ Isolated CSS  │  │ Isolated CSS  │  │ Isolated CSS  │
        └───────────────┘  └───────────────┘  └───────────────┘
```

See [architecture.md](./architecture.md) for detailed design documentation.

## Forms Implemented

1. User registration / sign up
2. User login / sign in
3. Password reset / forgot password request
4. Two-factor authentication code entry
5. Contact or support inquiry
6. Newsletter or marketing subscription
7. Profile information update
8. Account security and password change
9. Billing information capture
10. Shipping address capture
11. Checkout with payment details
12. Order tracking lookup
13. Appointment or booking request
14. Event registration / RSVP
15. Job application submission
16. Customer feedback or satisfaction survey
17. Support ticket submission
18. Multi-step onboarding wizard
19. Advanced search with filters
20. Privacy, consent, and communication preferences

## Design System Libraries (41)

MUI, Chakra UI, Ant Design, Arco Design, Ariakit, Atlassian Atlaskit, Base Web, Blueprint, Braid, Carbon, Cloudscape, CoreUI, DaisyUI, Elastic UI, Evergreen, Flowbite React, Fluent UI, Gravity UI, Grommet, Headless UI, Mantine, Material Tailwind, PatternFly, Pinterest Gestalt, PrimeReact, Primer React, Radix UI, React Bootstrap, React Spectrum, RSuite, Salesforce Lightning, Semantic UI React, Semi Design, Shadcn/ui, Shopify Polaris, Tamagui, Theme UI, U.S. Web Design System, Web Awesome, Zendesk Garden

## Tech Stack

- **Monorepo:** 42 separate Vite + React applications
- **Shell:** Main comparison UI
- **Library Apps:** Each design system in isolated app
- **Build:** Parallel build orchestration
- **Testing:** Playwright for E2E tests
- **Deployment:** GitHub Pages (static)

## System Design Concepts Demonstrated

1. **CSS Isolation** - iframe-based complete style isolation
2. **Monorepo Architecture** - Managing 42 interdependent apps
3. **Parallel Build Orchestration** - Efficient multi-app builds
4. **Static Site Generation** - GitHub Pages deployment
5. **Component Library Comparison** - Systematic UI library evaluation

## Development

```bash
# Install dependencies
bun install

# Run shell app in development mode
bun run dev:shell

# Build all 42 apps for production
bun run build

# Preview production build
bun run preview

# Run linting
bun run lint
```

## Notes

This is an external project. The full source code and implementation details are available in the [20forms-20designs repository](https://github.com/evgenyvinnik/20forms-20designs).
