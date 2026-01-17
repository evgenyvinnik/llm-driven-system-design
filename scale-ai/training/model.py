"""
CNN model architecture for shape recognition.
Small MobileNet-style architecture optimized for 64x64 grayscale images.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


class DepthwiseSeparableConv(nn.Module):
    """Depthwise separable convolution for efficiency."""

    def __init__(self, in_channels: int, out_channels: int, stride: int = 1):
        super().__init__()
        self.depthwise = nn.Conv2d(
            in_channels, in_channels, kernel_size=3, stride=stride,
            padding=1, groups=in_channels, bias=False
        )
        self.pointwise = nn.Conv2d(
            in_channels, out_channels, kernel_size=1, bias=False
        )
        self.bn1 = nn.BatchNorm2d(in_channels)
        self.bn2 = nn.BatchNorm2d(out_channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.depthwise(x)
        x = self.bn1(x)
        x = F.relu(x, inplace=True)
        x = self.pointwise(x)
        x = self.bn2(x)
        x = F.relu(x, inplace=True)
        return x


class DoodleNet(nn.Module):
    """
    Lightweight CNN for doodle/shape classification.
    Input: 64x64 grayscale images
    Output: Probabilities over 5 shape classes
    """

    def __init__(self, num_classes: int = 5):
        super().__init__()

        # Initial convolution
        self.conv1 = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=3, stride=2, padding=1, bias=False),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
        )

        # Depthwise separable convolutions
        self.features = nn.Sequential(
            DepthwiseSeparableConv(32, 64, stride=1),
            DepthwiseSeparableConv(64, 128, stride=2),
            DepthwiseSeparableConv(128, 128, stride=1),
            DepthwiseSeparableConv(128, 256, stride=2),
            DepthwiseSeparableConv(256, 256, stride=1),
            DepthwiseSeparableConv(256, 512, stride=2),
        )

        # Global average pooling + classifier
        self.avgpool = nn.AdaptiveAvgPool2d(1)
        self.classifier = nn.Sequential(
            nn.Dropout(0.2),
            nn.Linear(512, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.conv1(x)
        x = self.features(x)
        x = self.avgpool(x)
        x = torch.flatten(x, 1)
        x = self.classifier(x)
        return x

    def predict(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Return class predictions and confidence scores."""
        with torch.no_grad():
            logits = self.forward(x)
            probs = F.softmax(logits, dim=1)
            confidence, predicted = probs.max(1)
            return predicted, confidence


def create_model(num_classes: int = 5, pretrained_path: str | None = None) -> DoodleNet:
    """Create a DoodleNet model, optionally loading pretrained weights."""
    model = DoodleNet(num_classes=num_classes)

    if pretrained_path:
        state_dict = torch.load(pretrained_path, map_location='cpu')
        model.load_state_dict(state_dict)

    return model


def count_parameters(model: nn.Module) -> int:
    """Count trainable parameters."""
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


if __name__ == '__main__':
    # Test the model
    model = create_model()
    print(f"DoodleNet parameters: {count_parameters(model):,}")

    # Test forward pass
    x = torch.randn(1, 1, 64, 64)
    output = model(x)
    print(f"Input shape: {x.shape}")
    print(f"Output shape: {output.shape}")

    # Test prediction
    predicted, confidence = model.predict(x)
    print(f"Predicted class: {predicted.item()}, confidence: {confidence.item():.4f}")
