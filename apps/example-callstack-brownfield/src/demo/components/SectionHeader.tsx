// Section header component with directional badge
import type { FC } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../theme';

type Direction = 'native-to-js' | 'js-to-native' | 'local';

interface Props {
  title: string;
  direction: Direction;
  subtitle?: string;
}

const BADGE_LABELS: Record<Direction, string> = {
  'native-to-js': 'NATIVE → JS',
  'js-to-native': 'JS → NATIVE',
  local: 'LOCAL · JS ONLY',
};

const BADGE_COLORS: Record<Direction, string> = {
  'native-to-js': palette.amber,
  'js-to-native': palette.teal,
  local: palette.violet,
};

export const SectionHeader: FC<Props> = ({ title, direction, subtitle }) => {
  return (
    <View style={styles.container}>
      <View style={[styles.badge, { backgroundColor: BADGE_COLORS[direction] }]}>
        <Text style={styles.badgeText}>{BADGE_LABELS[direction]}</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
    gap: 4,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 2,
    marginBottom: 2,
  },
  badgeText: {
    fontFamily: typography.mono,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: palette.background,
  },
  title: {
    fontFamily: typography.display,
    fontSize: 18,
    fontWeight: '700',
    color: palette.textPrimary,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: typography.body,
    fontSize: 12,
    color: palette.textMuted,
    lineHeight: 16,
  },
});
