# Design Jira - Issue Tracking System

## Overview

A simplified Jira-like platform demonstrating issue tracking, workflow automation, permission systems, and reporting. This educational project focuses on building a project management system with customizable workflows.

## Key Features

### 1. Issue Management
- Create and edit issues
- Issue types (bug, story, task, epic)
- Custom fields
- Attachments and comments

### 2. Workflow Engine
- Customizable status transitions
- Workflow conditions and validators
- Automatic transitions
- Post-function actions

### 3. Project Organization
- Projects with boards
- Sprints and backlogs
- Epics and versions
- Components

### 4. Permissions
- Project roles
- Permission schemes
- Issue-level security
- Global permissions

### 5. Reporting
- Burndown charts
- Velocity reports
- Issue statistics
- Custom dashboards

## Implementation Status

- [ ] Initial architecture design
- [ ] Issue CRUD operations
- [ ] Workflow engine
- [ ] Board views (Kanban, Scrum)
- [ ] Permission system
- [ ] Search and filtering
- [ ] Reporting and dashboards
- [ ] Documentation

## Key Technical Challenges

1. **Workflow Engine**: Flexible, configurable state machines
2. **Custom Fields**: Dynamic schema per project
3. **Permission Complexity**: Role-based with project context
4. **JQL Parser**: Query language for issue search
5. **Audit Trail**: Tracking all issue changes

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
