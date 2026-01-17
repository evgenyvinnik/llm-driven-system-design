import { pool, query, queryOne, execute } from './utils/db.js';
import bcrypt from 'bcryptjs';
import { indexUser, indexJob } from './utils/elasticsearch.js';

async function seed() {
  console.log('Seeding database...');

  // Clear existing data
  await execute('TRUNCATE TABLE job_applications, job_skills, jobs, post_comments, post_likes, posts, connection_requests, connections, user_skills, education, experiences, skills, users, companies RESTART IDENTITY CASCADE');

  // Create skills
  const skillNames = [
    'JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'Java', 'Go',
    'PostgreSQL', 'MongoDB', 'Redis', 'Docker', 'Kubernetes', 'AWS', 'GCP',
    'Machine Learning', 'Data Science', 'Product Management', 'Agile', 'Scrum',
    'Leadership', 'Communication', 'Problem Solving', 'System Design'
  ];

  for (const name of skillNames) {
    await execute('INSERT INTO skills (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
  }
  console.log('Created skills');

  // Create companies
  const companies = [
    { name: 'TechCorp', slug: 'techcorp', description: 'Leading technology company', industry: 'Technology', size: '1001-5000', location: 'San Francisco, CA' },
    { name: 'DataFlow', slug: 'dataflow', description: 'Data analytics and AI solutions', industry: 'Technology', size: '201-500', location: 'New York, NY' },
    { name: 'CloudScale', slug: 'cloudscale', description: 'Cloud infrastructure platform', industry: 'Technology', size: '501-1000', location: 'Seattle, WA' },
    { name: 'StartupXYZ', slug: 'startupxyz', description: 'Innovative startup disrupting the market', industry: 'Technology', size: '11-50', location: 'Austin, TX' },
    { name: 'GlobalBank', slug: 'globalbank', description: 'International financial services', industry: 'Financial Services', size: '10001+', location: 'New York, NY' },
  ];

  const companyIds: number[] = [];
  for (const c of companies) {
    const result = await queryOne<{ id: number }>(
      'INSERT INTO companies (name, slug, description, industry, size, location) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [c.name, c.slug, c.description, c.industry, c.size, c.location]
    );
    companyIds.push(result!.id);
  }
  console.log('Created companies');

  // Create users
  const passwordHash = await bcrypt.hash('password123', 10);
  const users = [
    { email: 'alice@example.com', first_name: 'Alice', last_name: 'Johnson', headline: 'Senior Software Engineer at TechCorp', location: 'San Francisco, CA', industry: 'Technology', role: 'admin' },
    { email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', headline: 'Product Manager at DataFlow', location: 'New York, NY', industry: 'Technology', role: 'user' },
    { email: 'carol@example.com', first_name: 'Carol', last_name: 'Williams', headline: 'Data Scientist at CloudScale', location: 'Seattle, WA', industry: 'Technology', role: 'user' },
    { email: 'david@example.com', first_name: 'David', last_name: 'Brown', headline: 'Engineering Lead at TechCorp', location: 'San Francisco, CA', industry: 'Technology', role: 'user' },
    { email: 'emma@example.com', first_name: 'Emma', last_name: 'Davis', headline: 'Frontend Developer at StartupXYZ', location: 'Austin, TX', industry: 'Technology', role: 'user' },
    { email: 'frank@example.com', first_name: 'Frank', last_name: 'Miller', headline: 'Backend Engineer at CloudScale', location: 'Seattle, WA', industry: 'Technology', role: 'user' },
    { email: 'grace@example.com', first_name: 'Grace', last_name: 'Wilson', headline: 'DevOps Engineer at DataFlow', location: 'New York, NY', industry: 'Technology', role: 'user' },
    { email: 'henry@example.com', first_name: 'Henry', last_name: 'Taylor', headline: 'Solutions Architect at GlobalBank', location: 'New York, NY', industry: 'Financial Services', role: 'user' },
  ];

  const userIds: number[] = [];
  for (const u of users) {
    const result = await queryOne<{ id: number }>(
      'INSERT INTO users (email, password_hash, first_name, last_name, headline, location, industry, role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [u.email, passwordHash, u.first_name, u.last_name, u.headline, u.location, u.industry, u.role]
    );
    userIds.push(result!.id);

    // Index in Elasticsearch
    await indexUser({
      id: result!.id,
      first_name: u.first_name,
      last_name: u.last_name,
      headline: u.headline,
      location: u.location,
      industry: u.industry,
    });
  }
  console.log('Created users');

  // Add experiences
  const experiences = [
    { user_id: userIds[0], company_id: companyIds[0], company_name: 'TechCorp', title: 'Senior Software Engineer', start_date: '2020-01-01', is_current: true },
    { user_id: userIds[0], company_id: companyIds[3], company_name: 'StartupXYZ', title: 'Software Engineer', start_date: '2017-06-01', end_date: '2019-12-31', is_current: false },
    { user_id: userIds[1], company_id: companyIds[1], company_name: 'DataFlow', title: 'Product Manager', start_date: '2019-03-01', is_current: true },
    { user_id: userIds[2], company_id: companyIds[2], company_name: 'CloudScale', title: 'Data Scientist', start_date: '2021-01-01', is_current: true },
    { user_id: userIds[3], company_id: companyIds[0], company_name: 'TechCorp', title: 'Engineering Lead', start_date: '2018-01-01', is_current: true },
    { user_id: userIds[4], company_id: companyIds[3], company_name: 'StartupXYZ', title: 'Frontend Developer', start_date: '2022-01-01', is_current: true },
    { user_id: userIds[5], company_id: companyIds[2], company_name: 'CloudScale', title: 'Backend Engineer', start_date: '2020-06-01', is_current: true },
    { user_id: userIds[6], company_id: companyIds[1], company_name: 'DataFlow', title: 'DevOps Engineer', start_date: '2019-09-01', is_current: true },
    { user_id: userIds[7], company_id: companyIds[4], company_name: 'GlobalBank', title: 'Solutions Architect', start_date: '2017-01-01', is_current: true },
  ];

  for (const e of experiences) {
    await execute(
      'INSERT INTO experiences (user_id, company_id, company_name, title, start_date, end_date, is_current) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [e.user_id, e.company_id, e.company_name, e.title, e.start_date, e.end_date || null, e.is_current]
    );
  }
  console.log('Created experiences');

  // Add education
  const education = [
    { user_id: userIds[0], school_name: 'Stanford University', degree: 'M.S.', field_of_study: 'Computer Science', start_year: 2015, end_year: 2017 },
    { user_id: userIds[0], school_name: 'UC Berkeley', degree: 'B.S.', field_of_study: 'Computer Science', start_year: 2011, end_year: 2015 },
    { user_id: userIds[1], school_name: 'MIT', degree: 'MBA', field_of_study: 'Business Administration', start_year: 2016, end_year: 2018 },
    { user_id: userIds[2], school_name: 'Carnegie Mellon', degree: 'M.S.', field_of_study: 'Machine Learning', start_year: 2018, end_year: 2020 },
    { user_id: userIds[3], school_name: 'Stanford University', degree: 'B.S.', field_of_study: 'Computer Science', start_year: 2010, end_year: 2014 },
  ];

  for (const e of education) {
    await execute(
      'INSERT INTO education (user_id, school_name, degree, field_of_study, start_year, end_year) VALUES ($1, $2, $3, $4, $5, $6)',
      [e.user_id, e.school_name, e.degree, e.field_of_study, e.start_year, e.end_year]
    );
  }
  console.log('Created education');

  // Add skills to users
  const userSkillsMap = [
    { user_id: userIds[0], skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL', 'System Design'] },
    { user_id: userIds[1], skills: ['Product Management', 'Agile', 'Scrum', 'Communication', 'Leadership'] },
    { user_id: userIds[2], skills: ['Python', 'Machine Learning', 'Data Science', 'PostgreSQL', 'AWS'] },
    { user_id: userIds[3], skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Leadership', 'System Design'] },
    { user_id: userIds[4], skills: ['JavaScript', 'TypeScript', 'React', 'Node.js'] },
    { user_id: userIds[5], skills: ['Go', 'PostgreSQL', 'Redis', 'Docker', 'Kubernetes'] },
    { user_id: userIds[6], skills: ['Docker', 'Kubernetes', 'AWS', 'GCP', 'Python'] },
    { user_id: userIds[7], skills: ['Java', 'AWS', 'System Design', 'Leadership'] },
  ];

  for (const us of userSkillsMap) {
    for (const skillName of us.skills) {
      const skill = await queryOne<{ id: number }>('SELECT id FROM skills WHERE name = $1', [skillName]);
      if (skill) {
        await execute('INSERT INTO user_skills (user_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [us.user_id, skill.id]);
      }
    }
  }
  console.log('Created user skills');

  // Create connections (Alice knows everyone, Bob knows Carol and David, etc.)
  const connections = [
    [userIds[0], userIds[1]], // Alice - Bob
    [userIds[0], userIds[2]], // Alice - Carol
    [userIds[0], userIds[3]], // Alice - David
    [userIds[0], userIds[4]], // Alice - Emma
    [userIds[1], userIds[2]], // Bob - Carol
    [userIds[1], userIds[6]], // Bob - Grace
    [userIds[2], userIds[5]], // Carol - Frank
    [userIds[3], userIds[4]], // David - Emma
    [userIds[5], userIds[6]], // Frank - Grace
    [userIds[6], userIds[7]], // Grace - Henry
  ];

  for (const [id1, id2] of connections) {
    const [smaller, larger] = id1 < id2 ? [id1, id2] : [id2, id1];
    await execute('INSERT INTO connections (user_id, connected_to) VALUES ($1, $2) ON CONFLICT DO NOTHING', [smaller, larger]);
    await execute('UPDATE users SET connection_count = connection_count + 1 WHERE id IN ($1, $2)', [id1, id2]);
  }
  console.log('Created connections');

  // Create posts
  const posts = [
    { user_id: userIds[0], content: 'Excited to share that I just launched a new microservices architecture at TechCorp! The migration from monolith took 6 months but the results are worth it. Happy to discuss our approach.' },
    { user_id: userIds[1], content: 'Product managers: How do you balance feature requests from sales vs. engineering tech debt priorities? Would love to hear different frameworks people use.' },
    { user_id: userIds[2], content: 'Just published a new paper on applying transformer models to time series forecasting. Check it out on arXiv! #MachineLearning #DataScience' },
    { user_id: userIds[3], content: 'Looking for talented engineers to join our team at TechCorp. We are working on cutting-edge distributed systems. DM me if interested!' },
    { user_id: userIds[4], content: 'Finally finished migrating our frontend from JavaScript to TypeScript. The type safety has already caught 3 bugs in code review today!' },
    { user_id: userIds[5], content: 'Great talk at KubeCon today about service mesh patterns. Key takeaway: start simple, add complexity only when needed.' },
  ];

  for (const p of posts) {
    await execute('INSERT INTO posts (user_id, content) VALUES ($1, $2)', [p.user_id, p.content]);
  }
  console.log('Created posts');

  // Create jobs
  const jobs = [
    { company_id: companyIds[0], title: 'Senior Software Engineer', description: 'We are looking for a senior engineer to help build our next-generation platform. You will work on distributed systems, APIs, and cloud infrastructure.', location: 'San Francisco, CA', is_remote: true, employment_type: 'Full-time', experience_level: 'Senior', years_required: 5, salary_min: 180000, salary_max: 250000, skills: ['JavaScript', 'TypeScript', 'Node.js', 'PostgreSQL', 'AWS'] },
    { company_id: companyIds[1], title: 'Data Scientist', description: 'Join our data science team to build ML models that power our analytics platform. Work with petabytes of data and cutting-edge algorithms.', location: 'New York, NY', is_remote: false, employment_type: 'Full-time', experience_level: 'Mid-Level', years_required: 3, salary_min: 140000, salary_max: 180000, skills: ['Python', 'Machine Learning', 'Data Science'] },
    { company_id: companyIds[2], title: 'DevOps Engineer', description: 'Help us scale our infrastructure to millions of users. Experience with Kubernetes and cloud platforms required.', location: 'Seattle, WA', is_remote: true, employment_type: 'Full-time', experience_level: 'Senior', years_required: 4, salary_min: 160000, salary_max: 220000, skills: ['Docker', 'Kubernetes', 'AWS', 'GCP'] },
    { company_id: companyIds[3], title: 'Frontend Developer', description: 'Build beautiful user interfaces with React and TypeScript. We value creativity and attention to detail.', location: 'Austin, TX', is_remote: true, employment_type: 'Full-time', experience_level: 'Mid-Level', years_required: 2, salary_min: 120000, salary_max: 160000, skills: ['JavaScript', 'TypeScript', 'React'] },
    { company_id: companyIds[4], title: 'Solutions Architect', description: 'Design and implement enterprise solutions for our banking clients. Strong communication and technical skills required.', location: 'New York, NY', is_remote: false, employment_type: 'Full-time', experience_level: 'Senior', years_required: 7, salary_min: 200000, salary_max: 280000, skills: ['Java', 'AWS', 'System Design'] },
  ];

  for (const j of jobs) {
    const result = await queryOne<{ id: number }>(
      'INSERT INTO jobs (company_id, title, description, location, is_remote, employment_type, experience_level, years_required, salary_min, salary_max) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [j.company_id, j.title, j.description, j.location, j.is_remote, j.employment_type, j.experience_level, j.years_required, j.salary_min, j.salary_max]
    );

    // Add required skills
    for (const skillName of j.skills) {
      const skill = await queryOne<{ id: number }>('SELECT id FROM skills WHERE name = $1', [skillName]);
      if (skill) {
        await execute('INSERT INTO job_skills (job_id, skill_id, is_required) VALUES ($1, $2, true)', [result!.id, skill.id]);
      }
    }

    // Index in Elasticsearch
    const company = companies.find((_, i) => companyIds[i] === j.company_id);
    await indexJob({
      id: result!.id,
      title: j.title,
      description: j.description,
      company_name: company?.name || '',
      location: j.location,
      is_remote: j.is_remote,
      employment_type: j.employment_type,
      experience_level: j.experience_level,
      skills: j.skills,
      status: 'active',
    });
  }
  console.log('Created jobs');

  console.log('\nSeed complete!');
  console.log('\nTest accounts (all use password: password123):');
  console.log('  Admin: alice@example.com');
  console.log('  Users: bob@example.com, carol@example.com, david@example.com, emma@example.com, frank@example.com, grace@example.com, henry@example.com');

  await pool.end();
  process.exit(0);
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
