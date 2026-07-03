// ---------------------------------------------------------------------------
// LocalSection — "Local · Pure JS" panel
// Covers: getMotto (Sync), greet (Async), mood (State toggle).
// All resolved locally — NO native transport.
// ---------------------------------------------------------------------------
import type { FC } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { palette, spacing, typography } from '../theme';
import { DemoButton } from './DemoButton';
import { SectionHeader } from './SectionHeader';

interface Props {
  motto: string;
  greetName: string;
  onGreetNameChange: (v: string) => void;
  onGreet: () => void;
  greetResult: string;
  mood: string;
  onMoodCycle: () => void;
}

const MOOD_EMOJI: Record<string, string> = {
  happy: '😊',
  focused: '🎯',
  caffeinated: '☕',
  puzzled: '🤔',
  shipping: '🚀',
};

export const LocalSection: FC<Props> = ({
  motto,
  greetName,
  onGreetNameChange,
  onGreet,
  greetResult,
  mood,
  onMoodCycle,
}) => {
  const emoji = MOOD_EMOJI[mood] ?? '✨';

  return (
    <View style={styles.section}>
      <SectionHeader
        direction='local'
        title='Local · Pure JS'
        subtitle='No native involved. Contract provided + consumed in the same JS runtime.'
      />

      {/* Motto - Sync */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>SYNC · MOTTO</Text>
        <Text style={styles.motto} testID='bk_local_motto'>
          "{motto !== '' ? motto : '…'}"
        </Text>
      </View>

      {/* Greet - Async */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>ASYNC · GREET</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={greetName}
            onChangeText={onGreetNameChange}
            placeholder='your name…'
            placeholderTextColor={palette.textMuted}
            returnKeyType='done'
            onSubmitEditing={onGreet}
          />
          <DemoButton
            label='GREET'
            onPress={onGreet}
            accent='violet'
            testID='bk_local_greet_button'
          />
        </View>
        {greetResult !== '—' ? (
          <Text style={styles.greetResult} testID='bk_local_greet'>
            {greetResult}
          </Text>
        ) : null}
      </View>

      {/* Mood - State */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>STATE · MOOD</Text>
        <Text style={styles.blockHint}>Reactive state owned by the JS provider. Tap to cycle.</Text>
        <TouchableOpacity onPress={onMoodCycle} activeOpacity={0.7} style={styles.moodButton}>
          <Text style={styles.moodEmoji}>{emoji}</Text>
          <View>
            <Text style={styles.moodValue}>{mood}</Text>
            <Text style={styles.moodHint}>tap to cycle</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    gap: spacing.rowGap,
  },
  block: {
    gap: 8,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.divider,
  },
  blockLabel: {
    fontFamily: typography.mono,
    fontSize: 9,
    letterSpacing: 1.2,
    color: palette.violet,
    fontWeight: '700',
    marginBottom: 4,
  },
  blockHint: {
    fontFamily: typography.body,
    fontSize: 11,
    color: palette.textMuted,
    lineHeight: 15,
  },
  motto: {
    fontFamily: typography.body,
    fontSize: 15,
    color: palette.textPrimary,
    fontStyle: 'italic',
    lineHeight: 22,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: 36,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.surfaceBorder,
    borderRadius: 3,
    paddingHorizontal: 10,
    fontFamily: typography.mono,
    fontSize: 12,
    color: palette.textPrimary,
    backgroundColor: palette.surface,
  },
  greetResult: {
    fontFamily: typography.mono,
    fontSize: 11,
    color: palette.violet,
    lineHeight: 16,
  },
  moodButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: palette.violetSubtle,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.violet,
    alignSelf: 'flex-start',
  },
  moodEmoji: {
    fontSize: 28,
  },
  moodValue: {
    fontFamily: typography.mono,
    fontSize: 16,
    fontWeight: '700',
    color: palette.violet,
    letterSpacing: 0.3,
  },
  moodHint: {
    fontFamily: typography.mono,
    fontSize: 9,
    color: palette.textMuted,
    letterSpacing: 0.4,
    marginTop: 2,
  },
});
