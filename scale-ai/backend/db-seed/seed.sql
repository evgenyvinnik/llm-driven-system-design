-- Scale AI Data Labeling Platform Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Admin users
INSERT INTO admin_users (id, email, password_hash, name) VALUES
    ('a0000001-0000-0000-0000-000000000001', 'admin@scale.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User'),
    ('a0000002-0000-0000-0000-000000000002', 'alice@scale.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson'),
    ('a0000003-0000-0000-0000-000000000003', 'bob@scale.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith')
ON CONFLICT (email) DO NOTHING;

-- Sample users (drawing game participants)
INSERT INTO users (id, session_id, role, total_drawings) VALUES
    ('u0000001-0000-0000-0000-000000000001', 'session_alice_001', 'user', 45),
    ('u0000002-0000-0000-0000-000000000002', 'session_bob_002', 'user', 32),
    ('u0000003-0000-0000-0000-000000000003', 'session_carol_003', 'user', 78),
    ('u0000004-0000-0000-0000-000000000004', 'session_dave_004', 'user', 15),
    ('u0000005-0000-0000-0000-000000000005', 'session_eve_005', 'user', 120),
    ('u0000006-0000-0000-0000-000000000006', 'session_frank_006', 'admin', 5)
ON CONFLICT (session_id) DO NOTHING;

-- Sample drawings (references to MinIO paths)
INSERT INTO drawings (id, user_id, shape_id, stroke_data_path, metadata, quality_score, is_flagged) VALUES
    -- Line drawings
    ('d0000001-0000-0000-0000-000000000001', 'u0000001-0000-0000-0000-000000000001', 1, 'drawings/2025/01/d0000001.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 1200, "device": "desktop"}'::jsonb, 0.95, false),
    ('d0000002-0000-0000-0000-000000000002', 'u0000002-0000-0000-0000-000000000002', 1, 'drawings/2025/01/d0000002.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 980, "device": "mobile"}'::jsonb, 0.88, false),
    ('d0000003-0000-0000-0000-000000000003', 'u0000003-0000-0000-0000-000000000003', 1, 'drawings/2025/01/d0000003.json',
     '{"width": 400, "height": 400, "strokes": 2, "duration_ms": 1500, "device": "tablet"}'::jsonb, 0.72, false),

    -- Circle drawings
    ('d0000004-0000-0000-0000-000000000004', 'u0000001-0000-0000-0000-000000000001', 2, 'drawings/2025/01/d0000004.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 2100, "device": "desktop"}'::jsonb, 0.91, false),
    ('d0000005-0000-0000-0000-000000000005', 'u0000002-0000-0000-0000-000000000002', 2, 'drawings/2025/01/d0000005.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 1800, "device": "desktop"}'::jsonb, 0.85, false),
    ('d0000006-0000-0000-0000-000000000006', 'u0000004-0000-0000-0000-000000000004', 2, 'drawings/2025/01/d0000006.json',
     '{"width": 400, "height": 400, "strokes": 3, "duration_ms": 4500, "device": "mobile"}'::jsonb, 0.45, true),

    -- Square drawings
    ('d0000007-0000-0000-0000-000000000007', 'u0000003-0000-0000-0000-000000000003', 3, 'drawings/2025/01/d0000007.json',
     '{"width": 400, "height": 400, "strokes": 4, "duration_ms": 3200, "device": "desktop"}'::jsonb, 0.89, false),
    ('d0000008-0000-0000-0000-000000000008', 'u0000005-0000-0000-0000-000000000005', 3, 'drawings/2025/01/d0000008.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 2800, "device": "tablet"}'::jsonb, 0.92, false),

    -- Triangle drawings
    ('d0000009-0000-0000-0000-000000000009', 'u0000001-0000-0000-0000-000000000001', 4, 'drawings/2025/01/d0000009.json',
     '{"width": 400, "height": 400, "strokes": 3, "duration_ms": 2500, "device": "desktop"}'::jsonb, 0.87, false),
    ('d0000010-0000-0000-0000-000000000010', 'u0000005-0000-0000-0000-000000000005', 4, 'drawings/2025/01/d0000010.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 1900, "device": "desktop"}'::jsonb, 0.94, false),

    -- Heart drawings
    ('d0000011-0000-0000-0000-000000000011', 'u0000002-0000-0000-0000-000000000002', 5, 'drawings/2025/01/d0000011.json',
     '{"width": 400, "height": 400, "strokes": 2, "duration_ms": 3800, "device": "mobile"}'::jsonb, 0.78, false),
    ('d0000012-0000-0000-0000-000000000012', 'u0000003-0000-0000-0000-000000000003', 5, 'drawings/2025/01/d0000012.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 4200, "device": "desktop"}'::jsonb, 0.82, false),
    ('d0000013-0000-0000-0000-000000000013', 'u0000005-0000-0000-0000-000000000005', 5, 'drawings/2025/01/d0000013.json',
     '{"width": 400, "height": 400, "strokes": 2, "duration_ms": 3500, "device": "tablet"}'::jsonb, 0.90, false),

    -- More drawings for volume
    ('d0000014-0000-0000-0000-000000000014', 'u0000001-0000-0000-0000-000000000001', 2, 'drawings/2025/01/d0000014.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 1600, "device": "desktop"}'::jsonb, 0.93, false),
    ('d0000015-0000-0000-0000-000000000015', 'u0000004-0000-0000-0000-000000000004', 1, 'drawings/2025/01/d0000015.json',
     '{"width": 400, "height": 400, "strokes": 1, "duration_ms": 800, "device": "mobile"}'::jsonb, 0.96, false),

    -- Flagged/spam drawing
    ('d0000016-0000-0000-0000-000000000016', 'u0000004-0000-0000-0000-000000000004', 3, 'drawings/2025/01/d0000016.json',
     '{"width": 400, "height": 400, "strokes": 50, "duration_ms": 500, "device": "desktop"}'::jsonb, 0.12, true)
ON CONFLICT DO NOTHING;

-- Sample training jobs
INSERT INTO training_jobs (id, status, config, error_message, progress, started_at, completed_at, metrics, model_path, created_by) VALUES
    -- Completed training job
    ('tj000001-0000-0000-0000-000000000001', 'completed',
     '{"epochs": 50, "batch_size": 32, "learning_rate": 0.001, "optimizer": "adam", "min_quality_score": 0.7}'::jsonb,
     NULL,
     '{"current_epoch": 50, "total_epochs": 50, "current_loss": 0.0234, "phase": "complete"}'::jsonb,
     NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days' + INTERVAL '2 hours',
     '{"accuracy": 0.945, "loss": 0.0234, "val_accuracy": 0.932, "confusion_matrix": [[95,2,1,1,1],[2,94,1,2,1],[1,1,96,1,1],[1,2,1,95,1],[1,1,1,1,96]]}'::jsonb,
     'models/2025/01/model_v1.0.0.pt',
     'u0000006-0000-0000-0000-000000000006'),

    -- Another completed job
    ('tj000002-0000-0000-0000-000000000002', 'completed',
     '{"epochs": 100, "batch_size": 64, "learning_rate": 0.0005, "optimizer": "adam", "min_quality_score": 0.8}'::jsonb,
     NULL,
     '{"current_epoch": 100, "total_epochs": 100, "current_loss": 0.0156, "phase": "complete"}'::jsonb,
     NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '4 hours',
     '{"accuracy": 0.967, "loss": 0.0156, "val_accuracy": 0.958, "confusion_matrix": [[97,1,0,1,1],[1,96,1,1,1],[0,1,98,0,1],[1,1,0,97,1],[1,1,1,1,96]]}'::jsonb,
     'models/2025/01/model_v1.1.0.pt',
     'u0000006-0000-0000-0000-000000000006'),

    -- Running training job
    ('tj000003-0000-0000-0000-000000000003', 'running',
     '{"epochs": 75, "batch_size": 32, "learning_rate": 0.001, "optimizer": "sgd", "min_quality_score": 0.75}'::jsonb,
     NULL,
     '{"current_epoch": 42, "total_epochs": 75, "current_loss": 0.0512, "phase": "training"}'::jsonb,
     NOW() - INTERVAL '2 hours', NULL,
     NULL, NULL,
     'u0000006-0000-0000-0000-000000000006'),

    -- Failed training job
    ('tj000004-0000-0000-0000-000000000004', 'failed',
     '{"epochs": 50, "batch_size": 128, "learning_rate": 0.01, "optimizer": "adam", "min_quality_score": 0.9}'::jsonb,
     'CUDA out of memory. Tried to allocate 2.00 GiB',
     '{"current_epoch": 12, "total_epochs": 50, "current_loss": 0.4521, "phase": "training"}'::jsonb,
     NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days' + INTERVAL '30 minutes',
     NULL, NULL,
     'u0000006-0000-0000-0000-000000000006'),

    -- Pending training job
    ('tj000005-0000-0000-0000-000000000005', 'pending',
     '{"epochs": 100, "batch_size": 64, "learning_rate": 0.001, "optimizer": "adam", "min_quality_score": 0.7, "augmentation": true}'::jsonb,
     NULL,
     '{}'::jsonb,
     NULL, NULL,
     NULL, NULL,
     'u0000006-0000-0000-0000-000000000006')
ON CONFLICT DO NOTHING;

-- Trained models
INSERT INTO models (id, training_job_id, version, is_active, accuracy, model_path, config) VALUES
    ('m0000001-0000-0000-0000-000000000001', 'tj000001-0000-0000-0000-000000000001', 'v1.0.0', false, 0.945,
     'models/2025/01/model_v1.0.0.pt',
     '{"architecture": "DoodleNet", "input_size": 64, "num_classes": 5, "hidden_layers": [128, 64]}'::jsonb),

    ('m0000002-0000-0000-0000-000000000002', 'tj000002-0000-0000-0000-000000000002', 'v1.1.0', true, 0.967,
     'models/2025/01/model_v1.1.0.pt',
     '{"architecture": "DoodleNet", "input_size": 64, "num_classes": 5, "hidden_layers": [256, 128, 64]}'::jsonb)
ON CONFLICT DO NOTHING;
