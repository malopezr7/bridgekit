// Chat-like echo feed — shows the bidirectional round-trip messages
import type { FC } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { palette, typography } from '../theme';

export interface EchoEntry {
  id: string;
  direction: 'sent' | 'received';
  text: string;
  ts: number;
}

interface Props {
  entries: EchoEntry[];
}

export const EchoFeed: FC<Props> = ({ entries }) => {
  if (entries.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Type a message and tap SEND to start the round-trip</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.feed}
      contentContainerStyle={styles.feedContent}
      showsVerticalScrollIndicator={false}
    >
      {entries.map((e) => (
        <View
          key={e.id}
          style={[styles.entry, e.direction === 'received' ? styles.received : styles.sent]}
        >
          <Text style={styles.directionLabel}>
            {e.direction === 'sent' ? '▲ JS SENT' : '▼ NATIVE ECHO'}
          </Text>
          <Text style={[styles.entryText, e.direction === 'received' && styles.echoText]}>
            {e.text}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  empty: {
    height: 64,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.surfaceBorder,
    borderRadius: 3,
    borderStyle: 'dashed',
  },
  emptyText: {
    fontFamily: typography.mono,
    fontSize: 10,
    color: palette.textMuted,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  feed: {
    maxHeight: 160,
  },
  feedContent: {
    gap: 6,
  },
  entry: {
    padding: 8,
    borderRadius: 3,
    borderLeftWidth: 2,
  },
  sent: {
    backgroundColor: palette.amberSubtle,
    borderLeftColor: palette.amber,
  },
  received: {
    backgroundColor: palette.tealSubtle,
    borderLeftColor: palette.teal,
  },
  directionLabel: {
    fontFamily: typography.mono,
    fontSize: 8,
    letterSpacing: 0.8,
    color: palette.textMuted,
    marginBottom: 3,
  },
  entryText: {
    fontFamily: typography.mono,
    fontSize: 12,
    color: palette.textSecondary,
  },
  echoText: {
    color: palette.teal,
    fontWeight: '700',
  },
});
