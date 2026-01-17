import { useMemo } from 'react';

interface ReignsAvatarProps {
  seed: string;
  size?: number;
  className?: string;
}

// Seeded random number generator for deterministic results
function seededRandom(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  return function() {
    hash = Math.sin(hash) * 10000;
    return hash - Math.floor(hash);
  };
}

// Color palettes inspired by Reigns: Her Majesty medieval aesthetic
const SKIN_PALETTES = [
  { base: '#F5DEB3', shadow: '#DEB887', highlight: '#FFF8DC' },  // Wheat
  { base: '#D2B48C', shadow: '#BC8F8F', highlight: '#F5DEB3' },  // Tan
  { base: '#FFDAB9', shadow: '#E6C9A8', highlight: '#FFF5EE' },  // Peach
  { base: '#8B7355', shadow: '#6B5344', highlight: '#A08060' },  // Brown
  { base: '#CD853F', shadow: '#A0522D', highlight: '#DEB887' },  // Peru
  { base: '#F4E4D0', shadow: '#E8D4B8', highlight: '#FFFAF0' },  // Cream
];

const HAIR_COLORS = [
  { base: '#2C1810', highlight: '#4A3728' },  // Dark brown
  { base: '#8B4513', highlight: '#A0522D' },  // Saddle brown
  { base: '#FFD700', highlight: '#FFF8DC' },  // Golden
  { base: '#B87333', highlight: '#CD853F' },  // Copper
  { base: '#1C1C1C', highlight: '#383838' },  // Black
  { base: '#C0C0C0', highlight: '#E8E8E8' },  // Silver
  { base: '#8B0000', highlight: '#B22222' },  // Dark red
  { base: '#D2691E', highlight: '#E9967A' },  // Chocolate
];

const EYE_COLORS = [
  '#4169E1',  // Royal blue
  '#228B22',  // Forest green
  '#8B4513',  // Saddle brown
  '#2F4F4F',  // Dark slate
  '#6B8E23',  // Olive
  '#4682B4',  // Steel blue
  '#556B2F',  // Dark olive
  '#8B7355',  // Hazel
];

const CLOTHING_PALETTES = [
  { primary: '#8B0000', secondary: '#FFD700', accent: '#FFF8DC' },  // Royal red
  { primary: '#191970', secondary: '#C0C0C0', accent: '#B8860B' },  // Midnight blue
  { primary: '#2F4F4F', secondary: '#D4AF37', accent: '#F0E68C' },  // Dark slate
  { primary: '#4B0082', secondary: '#DDA0DD', accent: '#FFD700' },  // Indigo
  { primary: '#006400', secondary: '#DAA520', accent: '#FFFACD' },  // Dark green
  { primary: '#800020', secondary: '#FFE4E1', accent: '#C0C0C0' },  // Burgundy
  { primary: '#483D8B', secondary: '#E6E6FA', accent: '#B8860B' },  // Dark slate blue
  { primary: '#2E8B57', secondary: '#F0FFF0', accent: '#DAA520' },  // Sea green
];

const ACCESSORY_COLORS = [
  '#FFD700',  // Gold
  '#C0C0C0',  // Silver
  '#B8860B',  // Dark gold
  '#CD853F',  // Peru (bronze)
];

type Gender = 'masculine' | 'feminine';
type HairStyle = 'short' | 'medium' | 'long' | 'bald' | 'wavy' | 'braided';
type FaceShape = 'oval' | 'round' | 'angular' | 'square';

interface AvatarFeatures {
  gender: Gender;
  skinPalette: typeof SKIN_PALETTES[0];
  hairColor: typeof HAIR_COLORS[0];
  hairStyle: HairStyle;
  eyeColor: string;
  clothingPalette: typeof CLOTHING_PALETTES[0];
  accessoryColor: string;
  faceShape: FaceShape;
  hasBeard: boolean;
  hasCrown: boolean;
  hasNecklace: boolean;
  hasEarrings: boolean;
  eyeSize: number;
  noseSize: number;
  lipSize: number;
  browThickness: number;
  cheekbones: number;
}

function generateFeatures(seed: string): AvatarFeatures {
  const random = seededRandom(seed);

  const gender: Gender = random() > 0.5 ? 'feminine' : 'masculine';

  const hairStyles: HairStyle[] = gender === 'feminine'
    ? ['medium', 'long', 'wavy', 'braided']
    : ['short', 'medium', 'bald', 'wavy'];

  return {
    gender,
    skinPalette: SKIN_PALETTES[Math.floor(random() * SKIN_PALETTES.length)],
    hairColor: HAIR_COLORS[Math.floor(random() * HAIR_COLORS.length)],
    hairStyle: hairStyles[Math.floor(random() * hairStyles.length)],
    eyeColor: EYE_COLORS[Math.floor(random() * EYE_COLORS.length)],
    clothingPalette: CLOTHING_PALETTES[Math.floor(random() * CLOTHING_PALETTES.length)],
    accessoryColor: ACCESSORY_COLORS[Math.floor(random() * ACCESSORY_COLORS.length)],
    faceShape: (['oval', 'round', 'angular', 'square'] as FaceShape[])[Math.floor(random() * 4)],
    hasBeard: gender === 'masculine' && random() > 0.6,
    hasCrown: random() > 0.7,
    hasNecklace: random() > 0.5,
    hasEarrings: gender === 'feminine' && random() > 0.4,
    eyeSize: 0.8 + random() * 0.4,
    noseSize: 0.8 + random() * 0.4,
    lipSize: 0.8 + random() * 0.4,
    browThickness: 0.6 + random() * 0.6,
    cheekbones: random(),
  };
}

// SVG path generators for different face elements
function getFaceShape(shape: FaceShape, centerX: number, centerY: number, width: number, height: number): string {
  switch (shape) {
    case 'oval':
      return `M ${centerX} ${centerY - height/2}
              C ${centerX + width/2} ${centerY - height/2}
                ${centerX + width/2} ${centerY + height/3}
                ${centerX} ${centerY + height/2}
              C ${centerX - width/2} ${centerY + height/3}
                ${centerX - width/2} ${centerY - height/2}
                ${centerX} ${centerY - height/2} Z`;
    case 'round':
      return `M ${centerX} ${centerY - height/2}
              C ${centerX + width/2 * 1.1} ${centerY - height/3}
                ${centerX + width/2 * 1.1} ${centerY + height/3}
                ${centerX} ${centerY + height/2}
              C ${centerX - width/2 * 1.1} ${centerY + height/3}
                ${centerX - width/2 * 1.1} ${centerY - height/3}
                ${centerX} ${centerY - height/2} Z`;
    case 'angular':
      return `M ${centerX} ${centerY - height/2}
              L ${centerX + width/2} ${centerY - height/4}
              L ${centerX + width/3} ${centerY + height/3}
              L ${centerX} ${centerY + height/2}
              L ${centerX - width/3} ${centerY + height/3}
              L ${centerX - width/2} ${centerY - height/4} Z`;
    case 'square':
      return `M ${centerX} ${centerY - height/2}
              C ${centerX + width/2} ${centerY - height/2}
                ${centerX + width/2} ${centerY + height/4}
                ${centerX + width/3} ${centerY + height/2}
              L ${centerX - width/3} ${centerY + height/2}
              C ${centerX - width/2} ${centerY + height/4}
                ${centerX - width/2} ${centerY - height/2}
                ${centerX} ${centerY - height/2} Z`;
    default:
      return getFaceShape('oval', centerX, centerY, width, height);
  }
}

export default function ReignsAvatar({ seed, size = 400, className = '' }: ReignsAvatarProps) {
  const features = useMemo(() => generateFeatures(seed), [seed]);

  const cx = size / 2;
  const cy = size / 2;
  const faceWidth = size * 0.35;
  const faceHeight = size * 0.45;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      style={{ backgroundColor: '#2D2D2D' }}
    >
      <defs>
        {/* Painterly texture filter */}
        <filter id={`paint-${seed}`} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" result="noise"/>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G"/>
        </filter>

        {/* Shadow filter */}
        <filter id={`shadow-${seed}`} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.3"/>
        </filter>

        {/* Background gradient */}
        <radialGradient id={`bg-${seed}`} cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor={features.clothingPalette.primary} stopOpacity="0.3"/>
          <stop offset="100%" stopColor="#1a1a1a"/>
        </radialGradient>

        {/* Skin gradient */}
        <linearGradient id={`skin-${seed}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={features.skinPalette.highlight}/>
          <stop offset="50%" stopColor={features.skinPalette.base}/>
          <stop offset="100%" stopColor={features.skinPalette.shadow}/>
        </linearGradient>

        {/* Hair gradient */}
        <linearGradient id={`hair-${seed}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={features.hairColor.highlight}/>
          <stop offset="100%" stopColor={features.hairColor.base}/>
        </linearGradient>

        {/* Clothing gradient */}
        <linearGradient id={`cloth-${seed}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={features.clothingPalette.primary}/>
          <stop offset="100%" stopColor={features.clothingPalette.secondary}/>
        </linearGradient>

        {/* Metallic sheen for accessories */}
        <linearGradient id={`metal-${seed}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFF" stopOpacity="0.6"/>
          <stop offset="50%" stopColor={features.accessoryColor}/>
          <stop offset="100%" stopColor="#000" stopOpacity="0.3"/>
        </linearGradient>
      </defs>

      {/* Background */}
      <rect width={size} height={size} fill={`url(#bg-${seed})`}/>

      {/* Decorative frame border */}
      <rect
        x="8" y="8"
        width={size - 16}
        height={size - 16}
        fill="none"
        stroke={features.accessoryColor}
        strokeWidth="3"
        rx="4"
      />

      {/* Back hair (behind face) */}
      {features.hairStyle !== 'bald' && (
        <g filter={`url(#paint-${seed})`}>
          {features.hairStyle === 'long' && (
            <ellipse
              cx={cx}
              cy={cy - size * 0.02}
              rx={faceWidth * 1.4}
              ry={faceHeight * 1.3}
              fill={`url(#hair-${seed})`}
            />
          )}
          {features.hairStyle === 'wavy' && (
            <path
              d={`M ${cx - faceWidth * 1.3} ${cy - faceHeight * 0.3}
                  Q ${cx - faceWidth * 1.5} ${cy + faceHeight * 0.6}
                    ${cx - faceWidth * 0.8} ${cy + faceHeight * 1.1}
                  Q ${cx} ${cy + faceHeight * 1.3}
                    ${cx + faceWidth * 0.8} ${cy + faceHeight * 1.1}
                  Q ${cx + faceWidth * 1.5} ${cy + faceHeight * 0.6}
                    ${cx + faceWidth * 1.3} ${cy - faceHeight * 0.3}
                  Q ${cx} ${cy - faceHeight * 0.7}
                    ${cx - faceWidth * 1.3} ${cy - faceHeight * 0.3} Z`}
              fill={`url(#hair-${seed})`}
            />
          )}
          {features.hairStyle === 'braided' && (
            <>
              <ellipse
                cx={cx}
                cy={cy - size * 0.05}
                rx={faceWidth * 1.2}
                ry={faceHeight * 0.9}
                fill={`url(#hair-${seed})`}
              />
              {/* Braids */}
              <path
                d={`M ${cx - faceWidth * 0.9} ${cy + faceHeight * 0.2}
                    Q ${cx - faceWidth * 1.1} ${cy + faceHeight * 0.8}
                      ${cx - faceWidth * 0.7} ${cy + faceHeight * 1.2}
                    Q ${cx - faceWidth * 0.5} ${cy + faceHeight * 0.9}
                      ${cx - faceWidth * 0.6} ${cy + faceHeight * 0.3}`}
                fill={features.hairColor.base}
                stroke={features.hairColor.highlight}
                strokeWidth="2"
              />
              <path
                d={`M ${cx + faceWidth * 0.9} ${cy + faceHeight * 0.2}
                    Q ${cx + faceWidth * 1.1} ${cy + faceHeight * 0.8}
                      ${cx + faceWidth * 0.7} ${cy + faceHeight * 1.2}
                    Q ${cx + faceWidth * 0.5} ${cy + faceHeight * 0.9}
                      ${cx + faceWidth * 0.6} ${cy + faceHeight * 0.3}`}
                fill={features.hairColor.base}
                stroke={features.hairColor.highlight}
                strokeWidth="2"
              />
            </>
          )}
        </g>
      )}

      {/* Neck */}
      <path
        d={`M ${cx - faceWidth * 0.25} ${cy + faceHeight * 0.4}
            L ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.9}
            L ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.9}
            L ${cx + faceWidth * 0.25} ${cy + faceHeight * 0.4}`}
        fill={`url(#skin-${seed})`}
        stroke={features.skinPalette.shadow}
        strokeWidth="1.5"
      />

      {/* Clothing/Shoulders */}
      <path
        d={`M ${cx - faceWidth * 1.6} ${size}
            Q ${cx - faceWidth * 1.2} ${cy + faceHeight * 0.7}
              ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.85}
            L ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.85}
            Q ${cx + faceWidth * 1.2} ${cy + faceHeight * 0.7}
              ${cx + faceWidth * 1.6} ${size}
            Z`}
        fill={`url(#cloth-${seed})`}
        stroke={features.clothingPalette.secondary}
        strokeWidth="2"
        filter={`url(#paint-${seed})`}
      />

      {/* Clothing collar detail */}
      <path
        d={`M ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.85}
            Q ${cx} ${cy + faceHeight * 1.1}
              ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.85}`}
        fill="none"
        stroke={features.clothingPalette.accent}
        strokeWidth="3"
      />

      {/* Face */}
      <path
        d={getFaceShape(features.faceShape, cx, cy, faceWidth, faceHeight)}
        fill={`url(#skin-${seed})`}
        stroke={features.skinPalette.shadow}
        strokeWidth="2"
        filter={`url(#paint-${seed})`}
      />

      {/* Cheekbone highlights */}
      <ellipse
        cx={cx - faceWidth * 0.25}
        cy={cy + faceHeight * 0.05}
        rx={faceWidth * 0.12}
        ry={faceHeight * 0.06}
        fill={features.skinPalette.highlight}
        opacity={0.3 + features.cheekbones * 0.4}
      />
      <ellipse
        cx={cx + faceWidth * 0.25}
        cy={cy + faceHeight * 0.05}
        rx={faceWidth * 0.12}
        ry={faceHeight * 0.06}
        fill={features.skinPalette.highlight}
        opacity={0.3 + features.cheekbones * 0.4}
      />

      {/* Eyebrows */}
      <path
        d={`M ${cx - faceWidth * 0.32} ${cy - faceHeight * 0.12}
            Q ${cx - faceWidth * 0.2} ${cy - faceHeight * 0.18}
              ${cx - faceWidth * 0.08} ${cy - faceHeight * 0.12}`}
        fill="none"
        stroke={features.hairColor.base}
        strokeWidth={3 * features.browThickness}
        strokeLinecap="round"
      />
      <path
        d={`M ${cx + faceWidth * 0.32} ${cy - faceHeight * 0.12}
            Q ${cx + faceWidth * 0.2} ${cy - faceHeight * 0.18}
              ${cx + faceWidth * 0.08} ${cy - faceHeight * 0.12}`}
        fill="none"
        stroke={features.hairColor.base}
        strokeWidth={3 * features.browThickness}
        strokeLinecap="round"
      />

      {/* Eyes */}
      <g transform={`translate(${cx - faceWidth * 0.2}, ${cy - faceHeight * 0.02})`}>
        {/* Eye white */}
        <ellipse
          cx="0" cy="0"
          rx={12 * features.eyeSize}
          ry={8 * features.eyeSize}
          fill="#FFF8F0"
        />
        {/* Iris */}
        <circle
          cx="0" cy="0"
          r={6 * features.eyeSize}
          fill={features.eyeColor}
        />
        {/* Pupil */}
        <circle
          cx="0" cy="0"
          r={3 * features.eyeSize}
          fill="#1a1a1a"
        />
        {/* Eye highlight */}
        <circle
          cx={2 * features.eyeSize} cy={-2 * features.eyeSize}
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
        {/* Eyelashes for feminine */}
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

      <g transform={`translate(${cx + faceWidth * 0.2}, ${cy - faceHeight * 0.02})`}>
        {/* Eye white */}
        <ellipse
          cx="0" cy="0"
          rx={12 * features.eyeSize}
          ry={8 * features.eyeSize}
          fill="#FFF8F0"
        />
        {/* Iris */}
        <circle
          cx="0" cy="0"
          r={6 * features.eyeSize}
          fill={features.eyeColor}
        />
        {/* Pupil */}
        <circle
          cx="0" cy="0"
          r={3 * features.eyeSize}
          fill="#1a1a1a"
        />
        {/* Eye highlight */}
        <circle
          cx={2 * features.eyeSize} cy={-2 * features.eyeSize}
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
        {/* Eyelashes for feminine */}
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

      {/* Nose */}
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

      {/* Lips */}
      <g transform={`translate(${cx}, ${cy + faceHeight * 0.25})`}>
        {/* Upper lip */}
        <path
          d={`M ${-15 * features.lipSize} 0
              Q ${-8 * features.lipSize} ${-4 * features.lipSize}
                0 ${-2 * features.lipSize}
              Q ${8 * features.lipSize} ${-4 * features.lipSize}
                ${15 * features.lipSize} 0`}
          fill={features.gender === 'feminine' ? '#C44569' : features.skinPalette.shadow}
          stroke={features.skinPalette.shadow}
          strokeWidth="1"
        />
        {/* Lower lip */}
        <path
          d={`M ${-15 * features.lipSize} 0
              Q ${-8 * features.lipSize} ${8 * features.lipSize}
                0 ${10 * features.lipSize}
              Q ${8 * features.lipSize} ${8 * features.lipSize}
                ${15 * features.lipSize} 0`}
          fill={features.gender === 'feminine' ? '#E84A5F' : features.skinPalette.base}
          stroke={features.skinPalette.shadow}
          strokeWidth="1"
        />
        {/* Lip highlight */}
        <ellipse
          cx={-3 * features.lipSize}
          cy={3 * features.lipSize}
          rx={4 * features.lipSize}
          ry={2 * features.lipSize}
          fill="#FFF"
          opacity="0.2"
        />
      </g>

      {/* Beard for masculine */}
      {features.hasBeard && (
        <path
          d={`M ${cx - faceWidth * 0.3} ${cy + faceHeight * 0.15}
              Q ${cx - faceWidth * 0.35} ${cy + faceHeight * 0.4}
                ${cx - faceWidth * 0.15} ${cy + faceHeight * 0.55}
              Q ${cx} ${cy + faceHeight * 0.65}
                ${cx + faceWidth * 0.15} ${cy + faceHeight * 0.55}
              Q ${cx + faceWidth * 0.35} ${cy + faceHeight * 0.4}
                ${cx + faceWidth * 0.3} ${cy + faceHeight * 0.15}`}
          fill={features.hairColor.base}
          opacity="0.85"
          filter={`url(#paint-${seed})`}
        />
      )}

      {/* Top hair */}
      {features.hairStyle !== 'bald' && (
        <g filter={`url(#paint-${seed})`}>
          {features.hairStyle === 'short' && (
            <ellipse
              cx={cx}
              cy={cy - faceHeight * 0.35}
              rx={faceWidth * 0.85}
              ry={faceHeight * 0.35}
              fill={`url(#hair-${seed})`}
            />
          )}
          {features.hairStyle === 'medium' && (
            <path
              d={`M ${cx - faceWidth * 1.0} ${cy - faceHeight * 0.1}
                  Q ${cx - faceWidth * 1.1} ${cy - faceHeight * 0.5}
                    ${cx} ${cy - faceHeight * 0.55}
                  Q ${cx + faceWidth * 1.1} ${cy - faceHeight * 0.5}
                    ${cx + faceWidth * 1.0} ${cy - faceHeight * 0.1}
                  Q ${cx + faceWidth * 0.5} ${cy - faceHeight * 0.15}
                    ${cx} ${cy - faceHeight * 0.2}
                  Q ${cx - faceWidth * 0.5} ${cy - faceHeight * 0.15}
                    ${cx - faceWidth * 1.0} ${cy - faceHeight * 0.1} Z`}
              fill={`url(#hair-${seed})`}
            />
          )}
          {(features.hairStyle === 'long' || features.hairStyle === 'wavy' || features.hairStyle === 'braided') && (
            <path
              d={`M ${cx - faceWidth * 1.1} ${cy - faceHeight * 0.05}
                  Q ${cx - faceWidth * 1.2} ${cy - faceHeight * 0.5}
                    ${cx} ${cy - faceHeight * 0.6}
                  Q ${cx + faceWidth * 1.2} ${cy - faceHeight * 0.5}
                    ${cx + faceWidth * 1.1} ${cy - faceHeight * 0.05}
                  Q ${cx + faceWidth * 0.5} ${cy - faceHeight * 0.15}
                    ${cx} ${cy - faceHeight * 0.2}
                  Q ${cx - faceWidth * 0.5} ${cy - faceHeight * 0.15}
                    ${cx - faceWidth * 1.1} ${cy - faceHeight * 0.05} Z`}
              fill={`url(#hair-${seed})`}
            />
          )}
        </g>
      )}

      {/* Crown */}
      {features.hasCrown && (
        <g filter={`url(#shadow-${seed})`}>
          <path
            d={`M ${cx - faceWidth * 0.6} ${cy - faceHeight * 0.45}
                L ${cx - faceWidth * 0.5} ${cy - faceHeight * 0.7}
                L ${cx - faceWidth * 0.3} ${cy - faceHeight * 0.55}
                L ${cx - faceWidth * 0.15} ${cy - faceHeight * 0.8}
                L ${cx} ${cy - faceHeight * 0.6}
                L ${cx + faceWidth * 0.15} ${cy - faceHeight * 0.8}
                L ${cx + faceWidth * 0.3} ${cy - faceHeight * 0.55}
                L ${cx + faceWidth * 0.5} ${cy - faceHeight * 0.7}
                L ${cx + faceWidth * 0.6} ${cy - faceHeight * 0.45}
                Z`}
            fill={`url(#metal-${seed})`}
            stroke={features.accessoryColor}
            strokeWidth="2"
          />
          {/* Crown jewels */}
          <circle cx={cx} cy={cy - faceHeight * 0.72} r="5" fill="#E74C3C"/>
          <circle cx={cx - faceWidth * 0.35} cy={cy - faceHeight * 0.58} r="4" fill="#3498DB"/>
          <circle cx={cx + faceWidth * 0.35} cy={cy - faceHeight * 0.58} r="4" fill="#27AE60"/>
        </g>
      )}

      {/* Earrings */}
      {features.hasEarrings && (
        <>
          <circle
            cx={cx - faceWidth * 0.48}
            cy={cy + faceHeight * 0.05}
            r="6"
            fill={`url(#metal-${seed})`}
            stroke={features.accessoryColor}
            strokeWidth="1"
          />
          <circle
            cx={cx - faceWidth * 0.48}
            cy={cy + faceHeight * 0.12}
            r="4"
            fill="#E74C3C"
          />
          <circle
            cx={cx + faceWidth * 0.48}
            cy={cy + faceHeight * 0.05}
            r="6"
            fill={`url(#metal-${seed})`}
            stroke={features.accessoryColor}
            strokeWidth="1"
          />
          <circle
            cx={cx + faceWidth * 0.48}
            cy={cy + faceHeight * 0.12}
            r="4"
            fill="#E74C3C"
          />
        </>
      )}

      {/* Necklace */}
      {features.hasNecklace && (
        <g>
          <path
            d={`M ${cx - faceWidth * 0.3} ${cy + faceHeight * 0.55}
                Q ${cx} ${cy + faceHeight * 0.75}
                  ${cx + faceWidth * 0.3} ${cy + faceHeight * 0.55}`}
            fill="none"
            stroke={features.accessoryColor}
            strokeWidth="3"
          />
          <circle
            cx={cx}
            cy={cy + faceHeight * 0.72}
            r="8"
            fill={`url(#metal-${seed})`}
            stroke={features.accessoryColor}
            strokeWidth="1"
          />
          <circle
            cx={cx}
            cy={cy + faceHeight * 0.72}
            r="4"
            fill="#9B59B6"
          />
        </g>
      )}

      {/* Inner frame decoration */}
      <rect
        x="16" y="16"
        width={size - 32}
        height={size - 32}
        fill="none"
        stroke={features.accessoryColor}
        strokeWidth="1"
        strokeDasharray="8,4"
        opacity="0.5"
        rx="2"
      />
    </svg>
  );
}
