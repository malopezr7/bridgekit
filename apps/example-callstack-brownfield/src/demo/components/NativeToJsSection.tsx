// ---------------------------------------------------------------------------
// NativeToJsSection — "Native → JS" panel
// Covers: ping, counter (state), ticker (stream), echoes (stream, bidir).
// ---------------------------------------------------------------------------
import type { FC } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { palette, spacing, typography } from '../theme';
import { DemoButton } from './DemoButton';
import type { EchoEntry } from './EchoFeed';
import { EchoFeed } from './EchoFeed';
import { SectionHeader } from './SectionHeader';
import { TickerBar } from './TickerBar';

interface Props {
  // Ping
  pingResult: string;
  pinging: boolean;
  pingMessage: string;
  onPingMessageChange: (v: string) => void;
  onPing: () => void;
  // Counter + state
  counterValue: number;
  onIncrement: () => void;
  // Ticker
  tickerValues: number[];
  // Echo round-trip
  echoInput: string;
  onEchoInputChange: (v: string) => void;
  onSay: () => void;
  echoEntries: EchoEntry[];
}

export const NativeToJsSection: FC<Props> = ({
  pingResult,
  pinging,
  pingMessage,
  onPingMessageChange,
  onPing,
  counterValue,
  onIncrement,
  tickerValues,
  echoInput,
  onEchoInputChange,
  onSay,
  echoEntries,
}) => {
  return (
    <View style={styles.section}>
      <SectionHeader
        direction='native-to-js'
        title='Native → JS'
        subtitle='Native provides; JS consumes. Async, State, Stream.'
      />

      {/* Ping */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>ASYNC PING</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={pingMessage}
            onChangeText={onPingMessageChange}
            placeholder='message…'
            placeholderTextColor={palette.textMuted}
            returnKeyType='send'
            onSubmitEditing={onPing}
          />
          <DemoButton
            label='PING'
            onPress={onPing}
            loading={pinging}
            accent='amber'
            testID='bk_ping_button'
          />
        </View>
        {pingResult !== '—' ? (
          <Text style={styles.result} testID='bk_ping_result'>
            {pingResult}
          </Text>
        ) : null}
      </View>

      {/* Counter */}
      <View style={styles.block}>
        <View style={styles.counterRow}>
          <View>
            <Text style={styles.blockLabel}>STATE · COUNTER</Text>
            <Text style={styles.bigNumber} testID='bk_counter_value'>
              {counterValue}
            </Text>
          </View>
          <DemoButton
            label='INCREMENT'
            onPress={onIncrement}
            accent='amber'
            testID='bk_increment_button'
          />
        </View>
      </View>

      {/* Ticker stream */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>STREAM · TICKER</Text>
        <TickerBar
          values={tickerValues}
          accent={palette.amber}
          label='last tick'
          testID='bk_ticker_values'
        />
      </View>

      {/* Echo round-trip */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>BIDIRECTIONAL · ECHO</Text>
        <Text style={styles.blockHint}>
          JS sends text via Void → native transforms → echoes back via Stream
        </Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={echoInput}
            onChangeText={onEchoInputChange}
            placeholder='text to echo…'
            placeholderTextColor={palette.textMuted}
            returnKeyType='send'
            onSubmitEditing={onSay}
          />
          <DemoButton label='SEND' onPress={onSay} accent='amber' />
        </View>
        <View style={styles.echoContainer}>
          <EchoFeed entries={echoEntries} />
        </View>
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
    color: palette.amber,
    fontWeight: '700',
    marginBottom: 4,
  },
  blockHint: {
    fontFamily: typography.body,
    fontSize: 11,
    color: palette.textMuted,
    lineHeight: 15,
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
  result: {
    fontFamily: typography.mono,
    fontSize: 11,
    color: palette.textSecondary,
    lineHeight: 16,
  },
  counterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bigNumber: {
    fontFamily: typography.mono,
    fontSize: 36,
    fontWeight: '700',
    color: palette.amber,
    letterSpacing: -1,
  },
  echoContainer: {
    marginTop: 4,
  },
});
