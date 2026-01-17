"""
Preprocessing utilities to convert stroke data to images.
"""

import json
import numpy as np
from PIL import Image, ImageDraw
from typing import Any
import io


def strokes_to_image(
    stroke_data: dict[str, Any],
    size: int = 64,
    line_width: int = 2,
    padding: int = 4,
) -> np.ndarray:
    """
    Convert stroke data (JSON) to a grayscale image.

    Args:
        stroke_data: Dictionary containing 'strokes' and 'canvas' keys
        size: Output image size (square)
        line_width: Width of drawn lines
        padding: Padding around the drawing

    Returns:
        numpy array of shape (size, size) with values 0-255
    """
    # Create white canvas
    img = Image.new('L', (size, size), color=255)
    draw = ImageDraw.Draw(img)

    strokes = stroke_data.get('strokes', [])
    canvas = stroke_data.get('canvas', {'width': 400, 'height': 400})

    canvas_width = canvas.get('width', 400)
    canvas_height = canvas.get('height', 400)

    # Calculate scale to fit drawing in image with padding
    scale = (size - 2 * padding) / max(canvas_width, canvas_height)
    offset_x = padding
    offset_y = padding

    # Draw each stroke
    for stroke in strokes:
        points = stroke.get('points', [])
        if len(points) < 2:
            continue

        # Convert points to image coordinates
        coords = []
        for pt in points:
            x = pt['x'] * scale + offset_x
            y = pt['y'] * scale + offset_y
            coords.append((x, y))

        # Draw lines between consecutive points
        for i in range(len(coords) - 1):
            draw.line([coords[i], coords[i + 1]], fill=0, width=line_width)

    return np.array(img)


def load_stroke_data(json_str: str | bytes) -> dict[str, Any]:
    """Load stroke data from JSON string or bytes."""
    if isinstance(json_str, bytes):
        json_str = json_str.decode('utf-8')
    return json.loads(json_str)


def image_to_tensor(img: np.ndarray) -> np.ndarray:
    """
    Convert image to normalized tensor format.
    Normalizes to [0, 1] range and adds channel dimension.
    """
    # Normalize to [0, 1]
    img = img.astype(np.float32) / 255.0
    # Invert (black lines on white -> white lines on black for better learning)
    img = 1.0 - img
    # Add channel dimension
    img = np.expand_dims(img, axis=0)
    return img


def augment_image(img: np.ndarray, seed: int | None = None) -> np.ndarray:
    """
    Apply random augmentations to an image.

    Augmentations:
    - Random rotation (-15 to 15 degrees)
    - Random scale (0.9 to 1.1)
    - Random translation (-5 to 5 pixels)
    - Random noise
    """
    if seed is not None:
        np.random.seed(seed)

    pil_img = Image.fromarray(img)

    # Random rotation
    angle = np.random.uniform(-15, 15)
    pil_img = pil_img.rotate(angle, fillcolor=255)

    # Random scale
    scale = np.random.uniform(0.9, 1.1)
    new_size = int(pil_img.width * scale)
    pil_img = pil_img.resize((new_size, new_size), Image.Resampling.BILINEAR)

    # Crop or pad back to original size
    orig_size = img.shape[0]
    if new_size > orig_size:
        # Crop center
        left = (new_size - orig_size) // 2
        pil_img = pil_img.crop((left, left, left + orig_size, left + orig_size))
    elif new_size < orig_size:
        # Pad with white
        new_img = Image.new('L', (orig_size, orig_size), color=255)
        offset = (orig_size - new_size) // 2
        new_img.paste(pil_img, (offset, offset))
        pil_img = new_img

    result = np.array(pil_img)

    # Add small random noise
    noise = np.random.normal(0, 2, result.shape).astype(np.int32)
    result = np.clip(result.astype(np.int32) + noise, 0, 255).astype(np.uint8)

    return result


def batch_preprocess(
    stroke_data_list: list[dict[str, Any]],
    size: int = 64,
    augment: bool = False,
) -> np.ndarray:
    """
    Preprocess a batch of stroke data to image tensors.

    Returns:
        numpy array of shape (N, 1, size, size)
    """
    images = []
    for data in stroke_data_list:
        img = strokes_to_image(data, size=size)
        if augment:
            img = augment_image(img)
        tensor = image_to_tensor(img)
        images.append(tensor)

    return np.stack(images)


if __name__ == '__main__':
    # Test with sample data
    sample_stroke_data = {
        "shape": "circle",
        "canvas": {"width": 400, "height": 400},
        "strokes": [
            {
                "points": [
                    {"x": 200, "y": 100, "pressure": 0.5, "timestamp": 0},
                    {"x": 280, "y": 150, "pressure": 0.5, "timestamp": 1},
                    {"x": 300, "y": 200, "pressure": 0.5, "timestamp": 2},
                    {"x": 280, "y": 280, "pressure": 0.5, "timestamp": 3},
                    {"x": 200, "y": 300, "pressure": 0.5, "timestamp": 4},
                    {"x": 120, "y": 280, "pressure": 0.5, "timestamp": 5},
                    {"x": 100, "y": 200, "pressure": 0.5, "timestamp": 6},
                    {"x": 120, "y": 150, "pressure": 0.5, "timestamp": 7},
                    {"x": 200, "y": 100, "pressure": 0.5, "timestamp": 8},
                ],
                "color": "#000000",
                "width": 3
            }
        ],
        "duration_ms": 1000
    }

    img = strokes_to_image(sample_stroke_data)
    print(f"Image shape: {img.shape}")
    print(f"Image dtype: {img.dtype}")
    print(f"Value range: [{img.min()}, {img.max()}]")

    tensor = image_to_tensor(img)
    print(f"Tensor shape: {tensor.shape}")

    # Save test image
    Image.fromarray(img).save('/tmp/test_circle.png')
    print("Saved test image to /tmp/test_circle.png")
