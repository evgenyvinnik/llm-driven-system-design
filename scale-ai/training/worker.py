"""
Training worker that consumes jobs from RabbitMQ and trains models.
"""

import os
import json
import time
import io
from datetime import datetime
from typing import Any

import pika
import psycopg2
from minio import Minio
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
import numpy as np
from tqdm import tqdm
from sklearn.metrics import accuracy_score, confusion_matrix

from model import create_model, count_parameters
from preprocess import load_stroke_data, strokes_to_image, image_to_tensor, augment_image

# Configuration from environment
DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_PORT = int(os.getenv('DB_PORT', '5432'))
DB_NAME = os.getenv('DB_NAME', 'scaleai')
DB_USER = os.getenv('DB_USER', 'scaleai')
DB_PASSWORD = os.getenv('DB_PASSWORD', 'scaleai123')

MINIO_ENDPOINT = os.getenv('MINIO_ENDPOINT', 'localhost:9000')
MINIO_ACCESS_KEY = os.getenv('MINIO_ACCESS_KEY', 'minioadmin')
MINIO_SECRET_KEY = os.getenv('MINIO_SECRET_KEY', 'minioadmin')

RABBITMQ_HOST = os.getenv('RABBITMQ_HOST', 'localhost')
RABBITMQ_USER = os.getenv('RABBITMQ_USER', 'scaleai')
RABBITMQ_PASSWORD = os.getenv('RABBITMQ_PASSWORD', 'scaleai123')

QUEUE_NAME = 'training_jobs'
DRAWINGS_BUCKET = 'drawings'
MODELS_BUCKET = 'models'

# Shape name to index mapping
SHAPE_NAMES = ['circle', 'heart', 'line', 'square', 'triangle']
SHAPE_TO_IDX = {name: idx for idx, name in enumerate(SHAPE_NAMES)}


class DrawingDataset(Dataset):
    """Dataset for loading drawings from MinIO."""

    def __init__(
        self,
        drawings: list[dict[str, Any]],
        minio_client: Minio,
        augment: bool = False,
        image_size: int = 64,
    ):
        self.drawings = drawings
        self.minio = minio_client
        self.augment = augment
        self.image_size = image_size

    def __len__(self) -> int:
        return len(self.drawings)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, int]:
        drawing = self.drawings[idx]
        object_path = drawing['stroke_data_path']
        shape_name = drawing['shape_name']

        # Load stroke data from MinIO
        response = self.minio.get_object(DRAWINGS_BUCKET, object_path)
        stroke_data = json.loads(response.read().decode('utf-8'))
        response.close()
        response.release_conn()

        # Convert to image
        img = strokes_to_image(stroke_data, size=self.image_size)

        # Augment if training
        if self.augment:
            img = augment_image(img)

        # Convert to tensor
        tensor = image_to_tensor(img)
        tensor = torch.from_numpy(tensor).float()

        # Get label
        label = SHAPE_TO_IDX.get(shape_name, 0)

        return tensor, label


def get_db_connection():
    """Create database connection."""
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
    )


def get_minio_client() -> Minio:
    """Create MinIO client."""
    return Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False,
    )


def update_job_status(
    conn,
    job_id: str,
    status: str,
    metrics: dict | None = None,
    model_path: str | None = None,
    error_message: str | None = None,
):
    """Update training job status in database."""
    with conn.cursor() as cur:
        if status == 'running':
            cur.execute(
                "UPDATE training_jobs SET status = %s, started_at = NOW() WHERE id = %s",
                (status, job_id)
            )
        elif status in ('completed', 'failed'):
            cur.execute(
                """UPDATE training_jobs
                   SET status = %s, completed_at = NOW(),
                       metrics = %s, model_path = %s, error_message = %s
                   WHERE id = %s""",
                (status, json.dumps(metrics) if metrics else None, model_path, error_message, job_id)
            )
        else:
            cur.execute(
                "UPDATE training_jobs SET status = %s WHERE id = %s",
                (status, job_id)
            )
        conn.commit()


def fetch_training_data(conn, config: dict) -> list[dict[str, Any]]:
    """Fetch drawings for training from database."""
    # Build query with optional filters
    query = """
        SELECT d.id, d.stroke_data_path, s.name as shape_name
        FROM drawings d
        JOIN shapes s ON d.shape_id = s.id
        WHERE d.is_flagged = FALSE
    """
    params: list[Any] = []

    # Optional: filter by quality score
    min_quality = config.get('min_quality_score')
    if min_quality is not None:
        query += " AND (d.quality_score IS NULL OR d.quality_score >= %s)"
        params.append(min_quality)

    # Optional: limit samples
    max_samples = config.get('max_samples')
    if max_samples:
        query += f" ORDER BY RANDOM() LIMIT %s"
        params.append(max_samples)

    with conn.cursor() as cur:
        cur.execute(query, params)
        columns = [desc[0] for desc in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def train_model(
    train_loader: DataLoader,
    val_loader: DataLoader,
    config: dict,
    device: torch.device,
) -> tuple[nn.Module, dict]:
    """Train the model and return it with metrics."""
    epochs = config.get('epochs', 10)
    lr = config.get('learning_rate', 0.001)
    num_classes = len(SHAPE_NAMES)

    model = create_model(num_classes=num_classes).to(device)
    print(f"Model parameters: {count_parameters(model):,}")

    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=lr)
    scheduler = optim.lr_scheduler.StepLR(optimizer, step_size=5, gamma=0.5)

    best_val_acc = 0.0
    best_model_state = None
    history = {'train_loss': [], 'val_loss': [], 'val_acc': []}

    for epoch in range(epochs):
        # Training
        model.train()
        train_loss = 0.0
        train_samples = 0

        for images, labels in tqdm(train_loader, desc=f"Epoch {epoch+1}/{epochs}"):
            images = images.to(device)
            labels = labels.to(device)

            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            train_loss += loss.item() * images.size(0)
            train_samples += images.size(0)

        train_loss /= train_samples

        # Validation
        model.eval()
        val_loss = 0.0
        val_samples = 0
        all_preds = []
        all_labels = []

        with torch.no_grad():
            for images, labels in val_loader:
                images = images.to(device)
                labels = labels.to(device)

                outputs = model(images)
                loss = criterion(outputs, labels)

                val_loss += loss.item() * images.size(0)
                val_samples += images.size(0)

                preds = outputs.argmax(dim=1)
                all_preds.extend(preds.cpu().numpy())
                all_labels.extend(labels.cpu().numpy())

        val_loss /= val_samples
        val_acc = accuracy_score(all_labels, all_preds)

        history['train_loss'].append(train_loss)
        history['val_loss'].append(val_loss)
        history['val_acc'].append(val_acc)

        print(f"  Train Loss: {train_loss:.4f}, Val Loss: {val_loss:.4f}, Val Acc: {val_acc:.4f}")

        # Save best model
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_model_state = model.state_dict().copy()

        scheduler.step()

    # Load best model
    if best_model_state:
        model.load_state_dict(best_model_state)

    # Final evaluation
    model.eval()
    all_preds = []
    all_labels = []

    with torch.no_grad():
        for images, labels in val_loader:
            images = images.to(device)
            outputs = model(images)
            preds = outputs.argmax(dim=1)
            all_preds.extend(preds.cpu().numpy())
            all_labels.extend(labels.numpy())

    conf_matrix = confusion_matrix(all_labels, all_preds)

    metrics = {
        'accuracy': best_val_acc,
        'final_train_loss': history['train_loss'][-1],
        'final_val_loss': history['val_loss'][-1],
        'confusion_matrix': conf_matrix.tolist(),
        'history': history,
        'class_names': SHAPE_NAMES,
    }

    return model, metrics


def save_model_to_minio(
    model: nn.Module,
    job_id: str,
    minio_client: Minio,
) -> str:
    """Save model to MinIO and return the object path."""
    # Save model to buffer
    buffer = io.BytesIO()
    torch.save(model.state_dict(), buffer)
    buffer.seek(0)

    object_name = f"{job_id}.pt"
    minio_client.put_object(
        MODELS_BUCKET,
        object_name,
        buffer,
        length=buffer.getbuffer().nbytes,
        content_type='application/octet-stream',
    )

    return object_name


def create_model_record(
    conn,
    job_id: str,
    model_path: str,
    accuracy: float,
) -> str:
    """Create a model record in the database."""
    # Generate version string
    version = f"v{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO models (training_job_id, version, accuracy, model_path)
               VALUES (%s, %s, %s, %s)
               RETURNING id""",
            (job_id, version, accuracy, model_path)
        )
        model_id = cur.fetchone()[0]
        conn.commit()

    return str(model_id)


def process_job(job_id: str, config: dict):
    """Process a single training job."""
    print(f"\n{'='*60}")
    print(f"Processing job: {job_id}")
    print(f"Config: {json.dumps(config, indent=2)}")
    print(f"{'='*60}\n")

    conn = get_db_connection()
    minio_client = get_minio_client()

    try:
        # Update status to running
        update_job_status(conn, job_id, 'running')

        # Fetch training data
        print("Fetching training data...")
        drawings = fetch_training_data(conn, config)
        print(f"Found {len(drawings)} drawings")

        if len(drawings) < 10:
            raise ValueError(f"Not enough training data: {len(drawings)} drawings")

        # Split into train/val
        np.random.shuffle(drawings)
        split_idx = int(len(drawings) * 0.8)
        train_drawings = drawings[:split_idx]
        val_drawings = drawings[split_idx:]

        print(f"Train: {len(train_drawings)}, Val: {len(val_drawings)}")

        # Create datasets
        train_dataset = DrawingDataset(train_drawings, minio_client, augment=True)
        val_dataset = DrawingDataset(val_drawings, minio_client, augment=False)

        batch_size = config.get('batch_size', 32)
        train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
        val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

        # Train model
        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        print(f"Training on: {device}")

        model, metrics = train_model(train_loader, val_loader, config, device)
        print(f"\nFinal accuracy: {metrics['accuracy']:.4f}")

        # Save model to MinIO
        print("Saving model to MinIO...")
        model_path = save_model_to_minio(model, job_id, minio_client)

        # Create model record
        create_model_record(conn, job_id, model_path, metrics['accuracy'])

        # Update job as completed
        update_job_status(conn, job_id, 'completed', metrics=metrics, model_path=model_path)
        print(f"Job {job_id} completed successfully!")

    except Exception as e:
        print(f"Job {job_id} failed: {e}")
        update_job_status(conn, job_id, 'failed', error_message=str(e))
        raise

    finally:
        conn.close()


def main():
    """Main worker loop."""
    print("Starting training worker...")

    # Connect to RabbitMQ
    credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
    parameters = pika.ConnectionParameters(
        host=RABBITMQ_HOST,
        credentials=credentials,
    )

    connection = pika.BlockingConnection(parameters)
    channel = connection.channel()

    # Ensure queue exists
    channel.queue_declare(queue=QUEUE_NAME, durable=True)

    # Only process one job at a time
    channel.basic_qos(prefetch_count=1)

    def callback(ch, method, properties, body):
        try:
            message = json.loads(body.decode('utf-8'))
            job_id = message['jobId']
            config = message.get('config', {})

            process_job(job_id, config)
            ch.basic_ack(delivery_tag=method.delivery_tag)

        except Exception as e:
            print(f"Error processing message: {e}")
            # Don't requeue failed jobs
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

    channel.basic_consume(queue=QUEUE_NAME, on_message_callback=callback)

    print("Waiting for training jobs...")
    try:
        channel.start_consuming()
    except KeyboardInterrupt:
        print("Shutting down worker...")
        channel.stop_consuming()

    connection.close()


if __name__ == '__main__':
    main()
