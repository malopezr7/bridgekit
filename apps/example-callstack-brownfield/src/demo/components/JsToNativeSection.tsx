// ---------------------------------------------------------------------------
// JsToNativeSection — "JS → Native" panel
// Shows what JS provides (demo.jsinfo) that native DemoActivity consumes:
//   getReactNativeVersion, getUserLevel, getUserSegments, clockTicks.
// The JS provider is registered at mount; native calls it after connecting.
// ---------------------------------------------------------------------------
import type { FC } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { palette, spacing, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { TickerBar } from './TickerBar';
import { ValueRow } from './ValueRow';

interface Props {
  rnVersion: string;
  userLevel: { level: number; label: string } | null;
  userSegments: string[];
  clockTickValues: number[];
  jsStatusValue: string;
}

export const JsToNativeSection: FC<Props> = ({
  rnVersion,
  userLevel,
  userSegments,
  clockTickValues,
  jsStatusValue,
}) => {
  return (
    <View style={styles.section}>
      <SectionHeader
        direction='js-to-native'
        title='JS → Native'
        subtitle='JS provides; native DemoActivity consumes these values.'
      />

      {/* Provided values readout */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>PROVIDED BY JS · ASYNC METHODS</Text>
        <ValueRow label='getReactNativeVersion' value={rnVersion} accent={palette.teal} />
        <ValueRow
          label='getUserLevel'
          value={userLevel ? `${userLevel.level} · ${userLevel.label}` : '—'}
          accent={palette.teal}
        />
        <ValueRow
          label='getUserSegments'
          value={userSegments.length > 0 ? userSegments.join(', ') : '—'}
          accent={palette.teal}
        />
      </View>

      {/* clockTicks stream */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>STREAM · CLOCK TICKS (JS EMITS ~1/s)</Text>
        <Text style={styles.blockHint}>Native subscribes to this. Check Logcat: BridgeKit.</Text>
        <TickerBar values={clockTickValues} accent={palette.teal} label='ticks emitted' />
      </View>

      {/* jsStatus from demo.reverse */}
      <View style={styles.block}>
        <Text style={styles.blockLabel}>STATE · JS STATUS (demo.reverse)</Text>
        <Text style={styles.blockHint}>
          JS updates this every 3s. Native observes via StateFlow.
        </Text>
        <View style={styles.statusChip}>
          <View style={[styles.statusDot, { backgroundColor: palette.teal }]} />
          <Text style={[styles.statusText, { color: palette.teal }]}>{jsStatusValue}</Text>
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
    color: palette.teal,
    fontWeight: '700',
    marginBottom: 4,
  },
  blockHint: {
    fontFamily: typography.body,
    fontSize: 11,
    color: palette.textMuted,
    lineHeight: 15,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: palette.tealSubtle,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.teal,
    alignSelf: 'flex-start',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontFamily: typography.mono,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
