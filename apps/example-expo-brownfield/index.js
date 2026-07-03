/**
 * BridgeKit Expo Brownfield example — JS entry point.
 *
 * The pre-existing native app hosts this React Native surface on demand
 * (see ios/ and android/). `BridgeKitExpoBrownfield` is the component name the
 * native host loads when it presents the RN screen.
 */
import { AppRegistry } from 'react-native';

// Initialize the BridgeKit singleton (connects the Nitro transport) before any screen.
import '@malopezr7/bridgekit';
// Register demo.jsinfo / demo.local globally so native can consume JS at any time.
import './src/demo/registerHostProviders';

import { App } from './src/App';

AppRegistry.registerComponent('BridgeKitExpoBrownfield', () => App);
