// Animated live-value bar — shows last N ticker values as a mini histogram
import type { FC } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../theme';

interface Props {
  values: number[];
  accent: string;
  label?: string;
  testID?: string;
}

const BAR_COUNT = 8;
const BAR_MAX_HEIGHT = 32;

export const TickerBar: FC<Props> = ({ values, accent, label, testID }) => {
  const recent = values.slice(-BAR_COUNT);
  const max = Math.max(...recent, 1);

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.bars}>
        {Array.from({ length: BAR_COUNT }).map((_, i) => {
          const val = recent[i] ?? null;
          const height = val != null ? Math.max(4, (val / max) * BAR_MAX_HEIGHT) : 2;
          return (
            <View
              key={`bar-${i}`}
              style={[
                styles.bar,
                {
                  height,
                  backgroundColor: val != null ? accent : palette.surfaceBorder,
                  opacity: val != null ? 0.4 + 0.6 * ((i + 1) / BAR_COUNT) : 1,
                },
              ]}
            />
          );
        })}
      </View>
      <View style={styles.meta}>
        {label ? <Text style={styles.metaLabel}>{label}</Text> : null}
        <Text style={[styles.currentValue, { color: accent }]}>
          {values.length > 0 ? String(values[values.length - 1]) : '—'}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: BAR_MAX_HEIGHT,
  },
  bar: {
    width: 10,
    borderRadius: 1,
  },
  meta: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  metaLabel: {
    fontFamily: typography.mono,
    fontSize: 9,
    color: palette.textMuted,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  currentValue: {
    fontFamily: typography.mono,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
});
