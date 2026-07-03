// ---------------------------------------------------------------------------
// App — BridgeKit demo screen.
// Renders three panels: Native→JS, JS→Native, and Local (pure JS).
// All state logic lives in useDemoState.
// ---------------------------------------------------------------------------

import type { FC } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { JsToNativeSection } from './demo/components/JsToNativeSection';
import { LocalSection } from './demo/components/LocalSection';
import { NativeToJsSection } from './demo/components/NativeToJsSection';
import { palette, spacing, typography } from './demo/theme';
import { useDemoState } from './demo/useDemoState';

export const App: FC = () => {
  const state = useDemoState();

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps='handled'
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>BridgeKit</Text>
          <Text style={styles.headerSubtitle}>Native ↔ JS Bridge Demo</Text>
        </View>

        {/* Native → JS */}
        <NativeToJsSection
          pingResult={state.pingResult}
          pinging={state.pinging}
          pingMessage={state.pingMessage}
          onPingMessageChange={state.setPingMessage}
          onPing={state.handlePing}
          counterValue={state.counterValue}
          onIncrement={state.handleIncrement}
          tickerValues={state.tickerValues}
          echoInput={state.echoInput}
          onEchoInputChange={state.setEchoInput}
          onSay={state.handleSay}
          echoEntries={state.echoEntries}
        />

        <View style={styles.divider} />

        {/* JS → Native */}
        <JsToNativeSection
          rnVersion={state.rnVersion}
          userLevel={state.userLevel}
          userSegments={state.userSegments}
          clockTickValues={state.clockTickValues}
          jsStatusValue={state.jsStatus}
        />

        <View style={styles.divider} />

        {/* Local · Pure JS */}
        <LocalSection
          motto={state.motto}
          greetName={state.greetName}
          onGreetNameChange={state.setGreetName}
          onGreet={state.handleGreet}
          greetResult={state.greetResult}
          mood={state.mood}
          onMoodCycle={state.handleMoodCycle}
        />

        <View style={styles.footer} />
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.background,
  },
  scroll: {
    flex: 1,
  },
  container: {
    paddingHorizontal: spacing.screenH,
    paddingTop: spacing.screenV,
    gap: spacing.sectionGap,
  },
  header: {
    gap: 2,
    marginBottom: 4,
  },
  headerTitle: {
    fontFamily: typography.display,
    fontSize: 28,
    fontWeight: '700',
    color: palette.textPrimary,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontFamily: typography.mono,
    fontSize: 11,
    color: palette.textMuted,
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: palette.divider,
    marginVertical: 4,
  },
  footer: {
    height: 40,
  },
});
