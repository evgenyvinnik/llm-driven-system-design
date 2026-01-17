/**
 * @fileoverview Facial feature rendering components for the ReignsAvatar.
 * Includes eyes, eyebrows, nose, and lips with gender-specific styling.
 */

import type { AvatarRenderContext } from './types';

/**
 * Props for facial feature components.
 */
interface FacialFeaturesProps {
  /** Render context containing features and positioning */
  context: AvatarRenderContext;
}

/**
 * Renders the eyebrows with variable thickness based on browThickness feature.
 *
 * @param props - Component props with render context
 * @returns SVG group element with eyebrow paths
 */
export function Eyebrows({ context }: FacialFeaturesProps) {
  const { features, cx, cy, faceWidth, faceHeight } = context;

  return (
    <>
      {/* Left eyebrow */}
      <path
        d={`M ${cx - faceWidth * 0.32} ${cy - faceHeight * 0.12}
            Q ${cx - faceWidth * 0.2} ${cy - faceHeight * 0.18}
              ${cx - faceWidth * 0.08} ${cy - faceHeight * 0.12}`}
        fill="none"
        stroke={features.hairColor.base}
        strokeWidth={3 * features.browThickness}
        strokeLinecap="round"
      />
      {/* Right eyebrow */}
      <path
        d={`M ${cx + faceWidth * 0.32} ${cy - faceHeight * 0.12}
            Q ${cx + faceWidth * 0.2} ${cy - faceHeight * 0.18}
              ${cx + faceWidth * 0.08} ${cy - faceHeight * 0.12}`}
        fill="none"
        stroke={features.hairColor.base}
        strokeWidth={3 * features.browThickness}
        strokeLinecap="round"
      />
    </>
  );
}

/**
 * Props for a single eye rendering.
 */
interface EyeProps {
  /** Render context containing features and positioning */
  context: AvatarRenderContext;
  /** X position offset from center for this eye */
  xOffset: number;
}

/**
 * Renders a single eye with iris, pupil, highlights, and optional eyelashes.
 * Feminine avatars include decorative eyelashes.
 *
 * @param props - Component props with render context and position
 * @returns SVG group element with complete eye rendering
 */
function Eye({ context, xOffset }: EyeProps) {
  const { features, cx, cy, faceWidth, faceHeight } = context;
  const eyeX = cx + faceWidth * xOffset;
  const eyeY = cy - faceHeight * 0.02;

  return (
    <g transform={`translate(${eyeX}, ${eyeY})`}>
      {/* Eye white (sclera) */}
      <ellipse
        cx="0"
        cy="0"
        rx={12 * features.eyeSize}
        ry={8 * features.eyeSize}
        fill="#FFF8F0"
      />
      {/* Iris */}
      <circle cx="0" cy="0" r={6 * features.eyeSize} fill={features.eyeColor} />
      {/* Pupil */}
      <circle cx="0" cy="0" r={3 * features.eyeSize} fill="#1a1a1a" />
      {/* Eye highlight for depth */}
      <circle
        cx={2 * features.eyeSize}
        cy={-2 * features.eyeSize}
        r={2 * features.eyeSize}
        fill="#FFF"
        opacity="0.7"
      />
      {/* Upper eyelid line */}
      <path
        d={`M ${-12 * features.eyeSize} 0
            Q 0 ${-10 * features.eyeSize}
              ${12 * features.eyeSize} 0`}
        fill="none"
        stroke={features.skinPalette.shadow}
        strokeWidth="2"
      />
      {/* Eyelashes for feminine avatars */}
      {features.gender === 'feminine' && (
        <path
          d={`M ${-10 * features.eyeSize} ${-4 * features.eyeSize}
              L ${-12 * features.eyeSize} ${-8 * features.eyeSize}
              M ${-5 * features.eyeSize} ${-6 * features.eyeSize}
              L ${-6 * features.eyeSize} ${-10 * features.eyeSize}
              M 0 ${-7 * features.eyeSize}
              L 0 ${-11 * features.eyeSize}
              M ${5 * features.eyeSize} ${-6 * features.eyeSize}
              L ${6 * features.eyeSize} ${-10 * features.eyeSize}
              M ${10 * features.eyeSize} ${-4 * features.eyeSize}
              L ${12 * features.eyeSize} ${-8 * features.eyeSize}`}
          stroke="#1a1a1a"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

/**
 * Renders both eyes positioned symmetrically on the face.
 *
 * @param props - Component props with render context
 * @returns SVG group element with both eyes
 */
export function Eyes({ context }: FacialFeaturesProps) {
  return (
    <>
      <Eye context={context} xOffset={-0.2} />
      <Eye context={context} xOffset={0.2} />
    </>
  );
}

/**
 * Renders the nose with size variation based on noseSize feature.
 * Simple curved line style for the Reigns art aesthetic.
 *
 * @param props - Component props with render context
 * @returns SVG path element for the nose
 */
export function Nose({ context }: FacialFeaturesProps) {
  const { features, cx, cy, faceHeight } = context;

  return (
    <path
      d={`M ${cx} ${cy - faceHeight * 0.02}
          L ${cx - 4 * features.noseSize} ${cy + faceHeight * 0.12}
          Q ${cx} ${cy + faceHeight * 0.15}
            ${cx + 4 * features.noseSize} ${cy + faceHeight * 0.12}`}
      fill="none"
      stroke={features.skinPalette.shadow}
      strokeWidth="2"
      strokeLinecap="round"
    />
  );
}

/**
 * Renders the lips with gender-specific coloring.
 * Feminine avatars have lipstick coloring, masculine have natural tones.
 *
 * @param props - Component props with render context
 * @returns SVG group element with upper and lower lips
 */
export function Lips({ context }: FacialFeaturesProps) {
  const { features, cx, cy, faceHeight } = context;
  const lipY = cy + faceHeight * 0.25;

  // Lip colors differ by gender
  const upperLipColor = features.gender === 'feminine' ? '#C44569' : features.skinPalette.shadow;
  const lowerLipColor = features.gender === 'feminine' ? '#E84A5F' : features.skinPalette.base;

  return (
    <g transform={`translate(${cx}, ${lipY})`}>
      {/* Upper lip with cupid's bow */}
      <path
        d={`M ${-15 * features.lipSize} 0
            Q ${-8 * features.lipSize} ${-4 * features.lipSize}
              0 ${-2 * features.lipSize}
            Q ${8 * features.lipSize} ${-4 * features.lipSize}
              ${15 * features.lipSize} 0`}
        fill={upperLipColor}
        stroke={features.skinPalette.shadow}
        strokeWidth="1"
      />
      {/* Lower lip - fuller curve */}
      <path
        d={`M ${-15 * features.lipSize} 0
            Q ${-8 * features.lipSize} ${8 * features.lipSize}
              0 ${10 * features.lipSize}
            Q ${8 * features.lipSize} ${8 * features.lipSize}
              ${15 * features.lipSize} 0`}
        fill={lowerLipColor}
        stroke={features.skinPalette.shadow}
        strokeWidth="1"
      />
      {/* Lip highlight for shine */}
      <ellipse
        cx={-3 * features.lipSize}
        cy={3 * features.lipSize}
        rx={4 * features.lipSize}
        ry={2 * features.lipSize}
        fill="#FFF"
        opacity="0.2"
      />
    </g>
  );
}
