// ---------------------------------------------------------------------------
// BridgeKit Demo design tokens — light theme.
// ---------------------------------------------------------------------------

export const palette = {
  // Backgrounds
  background: '#FFFFFF',
  surface: '#F7F7F8',
  surfaceRaised: '#EFEFF2',
  surfaceBorder: '#DDDDE5',

  // Text
  textPrimary: '#111114',
  textSecondary: '#44444F',
  textMuted: '#8A8A9A',

  // Accents — one per direction, tuned for light bg readability
  amber: '#B45309', // native → JS  (darker amber for light bg)
  amberSubtle: '#FEF3C7',
  teal: '#0D7A6E', // JS → native  (darker teal for light bg)
  tealSubtle: '#CCFBF1',
  violet: '#5B21B6', // local / pure-JS  (darker violet for light bg)
  violetSubtle: '#EDE9FE',

  // Utility
  success: '#15803D',
  error: '#B91C1C',
  white: '#FFFFFF',

  // Divider
  divider: '#E5E5EC',
} as const;

export const typography = {
  display: 'System',
  body: 'System',
  mono: 'Courier New',
} as const;

export const spacing = {
  screenH: 20,
  screenV: 24,
  sectionGap: 32,
  rowGap: 10,
  innerPad: 16,
} as const;
