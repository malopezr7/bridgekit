/**
 * BridgeKit Callstack Brownfield example — JS entry point.
 *
 * The bare RN project is packaged into a self-contained native artifact
 * (XCFramework / AAR) by the @callstack/react-native-brownfield CLI, then
 * imported by the existing native host app (see ios/ and android/).
 * `BridgeKitCallstackBrownfield` is the component the native host presents.
 */
import { AppRegistry } from 'react-native';

// Initialize the BridgeKit singleton (connects the Nitro transport) before any screen.
import '@malopezr7/bridgekit';
// Register demo.jsinfo / demo.local globally so native can consume JS at any time.
import './src/demo/registerHostProviders';

import { App } from './src/App';

AppRegistry.registerComponent('BridgeKitCallstackBrownfield', () => App);
