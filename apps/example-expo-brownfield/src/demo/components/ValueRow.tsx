// Key-value row used in readout panels
import type { FC } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../theme';

interface Props {
  label: string;
  value: string;
  accent?: string;
  testID?: string;
}

export const ValueRow: FC<Props> = ({ label, value, accent, testID }) => (
  <View style={styles.row}>
    <Text style={styles.label}>{label}</Text>
    <Text style={[styles.value, accent ? { color: accent } : undefined]} testID={testID}>
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.divider,
    gap: 12,
  },
  label: {
    fontFamily: typography.mono,
    fontSize: 11,
    color: palette.textMuted,
    letterSpacing: 0.4,
    flexShrink: 0,
  },
  value: {
    fontFamily: typography.mono,
    fontSize: 11,
    color: palette.textSecondary,
    textAlign: 'right',
    flex: 1,
    flexWrap: 'wrap',
  },
});
