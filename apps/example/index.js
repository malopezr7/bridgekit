/**
 * BridgeKit Example app entry point.
 */
import { AppRegistry } from 'react-native';

// Initialize BridgeKit singleton (connects Nitro transport)
import '@malopezr7/bridgekit';
// Register demo.jsinfo globally so native can consume it at any time.
import './src/demo/registerHostProviders';

import { App } from './src/App';

AppRegistry.registerComponent('BridgeKitExample', () => App);
