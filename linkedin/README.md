# Design LinkedIn - Professional Social Network

## Overview

A simplified LinkedIn-like platform demonstrating professional social graphs, connection recommendations, feed ranking, and job matching algorithms. This educational project focuses on building a professional networking system with sophisticated recommendation engines.

## Key Features

### 1. Professional Profiles
- Work history and education
- Skills and endorsements
- Recommendations from connections
- Profile completeness scoring

### 2. Connection Graph
- First, second, third-degree connections
- Connection requests and acceptance
- Mutual connections display
- "People You May Know" recommendations

### 3. Feed & Content
- Professional posts and articles
- Engagement (likes, comments, shares)
- Feed ranking algorithm
- Content relevance scoring

### 4. Job Matching
- Job listings with requirements
- Candidate-job matching score
- Application tracking
- Recruiter search and InMail

### 5. Company Pages
- Company profiles and updates
- Employee directory
- Job postings per company
- Follower system

## Implementation Status

- [ ] Initial architecture design
- [ ] Database schema (users, companies, jobs, connections)
- [ ] Professional profile management
- [ ] Connection graph with degree calculation
- [ ] Feed ranking algorithm
- [ ] Job-candidate matching
- [ ] Recommendation engine
- [ ] Local multi-instance testing
- [ ] Documentation

## Key Technical Challenges

1. **Connection Degrees**: Efficiently computing 2nd and 3rd degree connections
2. **People You May Know**: Recommendation based on mutual connections, company, skills
3. **Feed Ranking**: Balancing recency, relevance, and engagement signals
4. **Job Matching**: Multi-factor scoring (skills, experience, location)
5. **Graph Queries**: Traversing professional networks efficiently

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
