# DubClub Mobile Prototype

This is a small Expo/React Native slice for the Staff Full Stack React Native submission.

It shows the fan-side product loop:

- live capper notifications
- reconnect state with last-seen cursor
- a tail-pick action
- a DubClub deep link into the pick detail surface

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
