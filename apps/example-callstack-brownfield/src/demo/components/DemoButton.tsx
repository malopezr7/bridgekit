// Minimal, sharp-edged action button
import type { FC } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { palette, typography } from '../theme';

interface Props {
  label: string;
  onPress: () => void;
  loading?: boolean;
  accent?: 'amber' | 'teal' | 'violet';
  disabled?: boolean;
  testID?: string;
}

const ACCENT_COLORS = {
  amber: palette.amber,
  teal: palette.teal,
  violet: palette.violet,
} as const;

export const DemoButton: FC<Props> = ({
  label,
  onPress,
  loading = false,
  accent = 'amber',
  disabled = false,
  testID,
}) => {
  const color = ACCENT_COLORS[accent];
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      testID={testID}
      activeOpacity={0.7}
    >
      <View
        style={[styles.button, { borderColor: color }, (disabled || loading) && styles.disabled]}
      >
        {loading ? (
          <ActivityIndicator size='small' color={color} />
        ) : (
          <Text style={[styles.label, { color }]}>{label}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  label: {
    fontFamily: typography.mono,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  disabled: {
    opacity: 0.4,
  },
});
