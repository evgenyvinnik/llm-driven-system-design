import { db } from '../src/models/db.js';
import { urlFrontier } from '../src/services/crawler.js';
import { indexer } from '../src/services/indexer.js';
import { bulkIndexDocuments } from '../src/models/elasticsearch.js';
import { hashUrl, extractDomain } from '../src/utils/helpers.js';

/**
 * Seed the database with sample data for testing
 */
async function seed() {
  console.log('Seeding database with sample data...');

  // Sample documents for testing (simulating crawled pages)
  const sampleDocs = [
    {
      url: 'https://example.com/programming/javascript-basics',
      title: 'JavaScript Basics: A Complete Guide for Beginners',
      description: 'Learn JavaScript from scratch with this comprehensive guide covering variables, functions, and more.',
      content: `JavaScript is a versatile programming language that powers the modern web.
        In this guide, we will cover the fundamentals of JavaScript including variables,
        data types, functions, loops, and conditionals. JavaScript was created by Brendan Eich
        in 1995 and has since become one of the most popular programming languages in the world.
        Variables in JavaScript can be declared using var, let, or const keywords.
        Functions are reusable blocks of code that perform specific tasks.
        Understanding these basics is essential for any web developer.`,
    },
    {
      url: 'https://example.com/programming/python-tutorial',
      title: 'Python Programming Tutorial: From Zero to Hero',
      description: 'Master Python programming with our step-by-step tutorial covering basics to advanced topics.',
      content: `Python is a powerful, easy-to-learn programming language known for its clean syntax.
        It is widely used in data science, machine learning, web development, and automation.
        Python was created by Guido van Rossum and first released in 1991.
        Key features include dynamic typing, automatic memory management, and extensive libraries.
        This tutorial covers variables, control flow, functions, classes, and modules.
        Python's philosophy emphasizes code readability and simplicity.`,
    },
    {
      url: 'https://example.com/web/react-introduction',
      title: 'Introduction to React: Building Modern User Interfaces',
      description: 'Learn React.js fundamentals and build interactive web applications with components.',
      content: `React is a JavaScript library for building user interfaces, developed by Facebook.
        It uses a component-based architecture that makes building complex UIs manageable.
        React introduces concepts like JSX, virtual DOM, and one-way data binding.
        Components can be functional or class-based, with hooks being the modern approach.
        State management in React can be handled with useState, useReducer, or external libraries.
        React's ecosystem includes React Router for navigation and Redux for state management.`,
    },
    {
      url: 'https://example.com/web/nodejs-backend',
      title: 'Building Backend Services with Node.js and Express',
      description: 'Create robust backend APIs using Node.js, Express, and modern best practices.',
      content: `Node.js allows JavaScript to run on the server side, enabling full-stack JavaScript development.
        Express is a minimal and flexible Node.js web application framework.
        Building REST APIs with Express involves defining routes, middleware, and controllers.
        Best practices include proper error handling, input validation, and authentication.
        Database integration can be done with PostgreSQL, MongoDB, or other databases.
        Node.js uses an event-driven, non-blocking I/O model for high performance.`,
    },
    {
      url: 'https://example.com/database/sql-fundamentals',
      title: 'SQL Fundamentals: Mastering Relational Databases',
      description: 'Learn SQL from scratch and master querying, joining, and optimizing relational databases.',
      content: `SQL (Structured Query Language) is the standard language for relational databases.
        Key SQL operations include SELECT, INSERT, UPDATE, and DELETE statements.
        Joins allow combining data from multiple tables: INNER JOIN, LEFT JOIN, RIGHT JOIN.
        Indexes improve query performance by creating efficient data access paths.
        Database normalization reduces redundancy and improves data integrity.
        Popular SQL databases include PostgreSQL, MySQL, and Microsoft SQL Server.`,
    },
    {
      url: 'https://example.com/devops/docker-containerization',
      title: 'Docker Containerization: A Practical Guide',
      description: 'Master Docker containers for deploying applications consistently across environments.',
      content: `Docker is a platform for developing, shipping, and running applications in containers.
        Containers package applications with their dependencies for consistent deployment.
        Dockerfiles define how to build container images step by step.
        Docker Compose allows defining and running multi-container applications.
        Benefits include portability, isolation, and efficient resource utilization.
        Container orchestration tools like Kubernetes manage containers at scale.`,
    },
    {
      url: 'https://example.com/algorithms/search-algorithms',
      title: 'Search Algorithms: Binary Search and Beyond',
      description: 'Understand search algorithms including binary search, linear search, and their applications.',
      content: `Search algorithms are fundamental to computer science and software development.
        Linear search checks each element sequentially with O(n) time complexity.
        Binary search works on sorted arrays with O(log n) time complexity.
        Binary search repeatedly divides the search interval in half.
        Hash-based search provides O(1) average case using hash tables.
        Understanding search algorithms is crucial for coding interviews and efficient programs.`,
    },
    {
      url: 'https://example.com/algorithms/sorting-algorithms',
      title: 'Sorting Algorithms Explained: From Bubble Sort to Quick Sort',
      description: 'Learn popular sorting algorithms, their implementations, and performance characteristics.',
      content: `Sorting algorithms arrange elements in a specific order, typically ascending or descending.
        Bubble sort is simple but inefficient with O(n^2) time complexity.
        Merge sort uses divide and conquer with O(n log n) guaranteed performance.
        Quick sort is often faster in practice with O(n log n) average case.
        Selection sort repeatedly finds the minimum element from unsorted portion.
        Understanding sorting helps in choosing the right algorithm for different scenarios.`,
    },
    {
      url: 'https://example.com/security/web-security-basics',
      title: 'Web Security Basics: Protecting Your Applications',
      description: 'Learn essential web security concepts including XSS, CSRF, SQL injection, and prevention.',
      content: `Web security is crucial for protecting applications and user data from attacks.
        Cross-Site Scripting (XSS) allows attackers to inject malicious scripts.
        SQL injection exploits vulnerabilities in database queries.
        Cross-Site Request Forgery (CSRF) tricks users into unwanted actions.
        Prevention includes input validation, output encoding, and using prepared statements.
        HTTPS encrypts data in transit using TLS/SSL protocols.`,
    },
    {
      url: 'https://example.com/career/tech-interview-prep',
      title: 'Tech Interview Preparation: Complete Strategy Guide',
      description: 'Prepare for technical interviews with tips on algorithms, system design, and soft skills.',
      content: `Technical interviews test problem-solving, coding skills, and system design knowledge.
        Practice coding problems on platforms like LeetCode, HackerRank, and CodeSignal.
        System design interviews assess ability to design scalable distributed systems.
        Behavioral questions evaluate teamwork, leadership, and conflict resolution skills.
        Mock interviews help build confidence and identify areas for improvement.
        Companies like Google, Amazon, and Meta have multi-round interview processes.`,
    },
  ];

  try {
    // Insert URLs and documents
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const esDocuments = [];

      for (const doc of sampleDocs) {
        const urlHash = hashUrl(doc.url);
        const domain = extractDomain(doc.url);

        // Insert URL
        const urlResult = await client.query(
          `INSERT INTO urls (url_hash, url, domain, crawl_status, page_rank, priority)
           VALUES ($1, $2, $3, 'crawled', $4, 0.5)
           ON CONFLICT (url_hash) DO UPDATE SET crawl_status = 'crawled'
           RETURNING id`,
          [urlHash, doc.url, domain, Math.random() * 0.01]
        );

        const urlId = urlResult.rows[0].id;

        // Insert document
        await client.query(
          `INSERT INTO documents (url_id, url, title, description, content, content_length)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (url_id) DO UPDATE
           SET title = $3, description = $4, content = $5, content_length = $6`,
          [urlId, doc.url, doc.title, doc.description, doc.content, doc.content.length]
        );

        // Prepare for Elasticsearch
        esDocuments.push({
          url_id: urlId,
          url: doc.url,
          title: doc.title,
          description: doc.description,
          content: doc.content,
          domain,
          page_rank: Math.random() * 0.01,
          inlink_count: Math.floor(Math.random() * 10),
          fetch_time: new Date(),
          content_length: doc.content.length,
        });
      }

      // Create some links between documents
      const urlResults = await client.query('SELECT id FROM urls ORDER BY id');
      const urlIds = urlResults.rows.map((r) => r.id);

      for (let i = 0; i < urlIds.length; i++) {
        // Each page links to 2-3 random other pages
        const numLinks = 2 + Math.floor(Math.random() * 2);
        for (let j = 0; j < numLinks; j++) {
          const targetIdx = Math.floor(Math.random() * urlIds.length);
          if (targetIdx !== i) {
            await client.query(
              `INSERT INTO links (source_url_id, target_url_id)
               VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [urlIds[i], urlIds[targetIdx]]
            );
          }
        }
      }

      // Add sample search suggestions
      const suggestions = [
        'javascript tutorial',
        'python programming',
        'react components',
        'node.js api',
        'sql database',
        'docker containers',
        'binary search',
        'sorting algorithms',
        'web security',
        'tech interview',
        'programming basics',
        'web development',
      ];

      for (const suggestion of suggestions) {
        await client.query(
          `INSERT INTO search_suggestions (query, frequency)
           VALUES ($1, $2)
           ON CONFLICT (query) DO UPDATE SET frequency = search_suggestions.frequency + 1`,
          [suggestion, Math.floor(Math.random() * 100) + 1]
        );
      }

      await client.query('COMMIT');

      // Index documents in Elasticsearch
      console.log('Indexing documents in Elasticsearch...');
      await bulkIndexDocuments(esDocuments);

      // Update inlink counts
      await indexer.updateInlinkCounts();

      console.log(`Seeded ${sampleDocs.length} documents`);
      console.log(`Seeded ${suggestions.length} search suggestions`);
      console.log('Database seeded successfully!');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Seed error:', error);
  } finally {
    process.exit(0);
  }
}

seed();
