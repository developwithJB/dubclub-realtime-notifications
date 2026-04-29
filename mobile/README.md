# DubClub Mobile Prototype

This is a focused Expo/React Native slice for the Staff Full Stack React Native submission. It is designed as a mobile-first fan surface rather than a web dashboard squeezed onto a phone.

It shows the fan-side product loop DubClub cares about:

- live capper notifications
- reconnect state with last-seen cursor
- a tail-pick action
- reward/result context
- capper record and pick lifecycle trust context
- responsible-play copy as a lightweight product guardrail
- a DubClub deep link into the pick detail surface

## React Native product pass

The app now demonstrates mobile judgment in the areas the role calls out:

- segmented `Alerts` / `Ledger` views so fans can separate urgent picks from trust history
- large touch targets with `Pressable`, hit slop, accessible roles, and disabled tailed states
- realtime connection status plus visible last-seen cursor behavior for reconnect confidence
- reusable card, pick slip, summary tile, segment, and trust-panel components
- sample live pick, odds movement, graded result, and reward states for reviewer walkthroughs
- mobile-native visual hierarchy: compact header, summary tiles, status pills, scrollable card feed, and bottom actions per card
- fan-safety and trust UX placed next to the decision, not buried in docs

Run it after the backend is running:

```bash
cd mobile
npm install
npm run ios
```

For a physical device, set:

```bash
EXPO_PUBLIC_API_BASE=http://YOUR_LAN_IP:4000
EXPO_PUBLIC_WS_URL=ws://YOUR_LAN_IP:4000
```
