# Design GitHub - Code Hosting Platform

## Overview

A simplified GitHub-like platform demonstrating Git hosting, pull request workflows, code search, and CI/CD integration. This educational project focuses on building a collaborative code hosting system with version control features.

## Key Features

### 1. Repository Management
- Create and manage repositories
- Public and private visibility
- Branch protection rules
- Collaborator permissions

### 2. Git Operations
- Push/pull/clone support
- Branch management
- Commit history visualization
- Diff viewing

### 3. Pull Requests
- Create PRs from branches
- Code review with comments
- Merge strategies (merge, squash, rebase)
- Conflict detection

### 4. Code Search
- Full-text code search
- Symbol search
- Cross-repository search
- Language-aware indexing

### 5. CI/CD Integration
- Workflow definitions (YAML)
- Build status on PRs
- Automated testing
- Deployment triggers

## Implementation Status

- [ ] Initial architecture design
- [ ] Repository creation and storage
- [ ] Git protocol support
- [ ] Pull request workflow
- [ ] Code review system
- [ ] Code search with Elasticsearch
- [ ] Basic CI/CD runner
- [ ] Documentation

## Key Technical Challenges

1. **Git Storage**: Efficiently storing and serving Git objects
2. **Code Search**: Indexing millions of files with language awareness
3. **Large Repos**: Handling monorepos with millions of files
4. **PR Diffs**: Computing diffs for large changesets
5. **Webhook Delivery**: Reliable event delivery to integrations

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
