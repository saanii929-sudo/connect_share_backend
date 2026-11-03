# Android Networking Analysis — ConnectShare

## Summary

Android **can** act as both an internet-sharing gateway and a VPN client without root access, but through a fundamentally different mechanism than Linux kernel WireGuard. This document explains the constraints, the chosen architecture, and the fallback path.

---

## 1. Why Kernel WireGuard Does Not Work on Stock Android

| Requirement | Linux Host | Android (no root) |
|---|---|---|
| Load kernel module (`wireguard.ko`) | ✅ | ❌ |
| `wg-quick up` | ✅ | ❌ |
| `sysctl net.ipv4.ip_forward=1` | ✅ | ❌ Kernel-level, requires root |
| `iptables MASQUERADE` | ✅ | ❌ Requires root |
| Modify routing tables | ✅ | ❌ `ip rule add` requires `NET_ADMIN` |

The WireGuard kernel implementation requires `CAP_NET_ADMIN` and direct access to the network namespace. Stock Android provides neither to unprivileged apps.

**wireguard-android** (the official Android WireGuard app) uses the `VpnService` API and reads/writes the tun interface from user-space using a Kotlin/Java implementation of the WireGuard protocol. This works for the **recipient** side (routing traffic through a VPN endpoint). It does **not** solve the **creator** side (forwarding other devices' traffic through your mobile connection).

---

## 2. Android VpnService — What It Actually Provides

`android.net.VpnService` (API level 14+) lets an unprivileged app:

1. **Create a virtual tun interface** via `VpnService.Builder.establish()` → returns a `ParcelFileDescriptor`.
2. **Read raw IP packets** from the tun file descriptor (device-originated traffic).
3. **Write raw IP packets** back to the tun file descriptor (responses to device).
4. **Protect** specific sockets from being routed through the VPN interface using `VpnService.protect(socket)` — this is essential to prevent the relay socket from looping through the VPN.

What `VpnService` does **not** do:

- Forward packets to another device's internet connection.
- Perform NAT at the kernel level.
- Share the host's cellular/WiFi connection with anyone else.

**Conclusion**: `VpnService` solves the **recipient** side cleanly (recipient routes traffic through the VPN). For the **creator** side, a different mechanism is needed.

---

## 3. Creator Side — Forwarding Traffic on Android Without Root

### Option A: Not Feasible — Kernel-level IP forwarding

Requires root. Eliminated.

### Option B: Not Feasible — Running a WireGuard server on Android

The Android creator device cannot run `wg-quick` in server mode (listener role) because:
- No kernel module access.
- Port 51820/UDP cannot be opened on most carrier NATs.
- Even if opened, the device cannot do `MASQUERADE` forwarding.

Eliminated for kernel mode. The user-space relay approach below is the validated alternative.

### Option C: Validated — User-Space Relay with Socket-Level Forwarding ✅

This is the architecture ConnectShare implements.

**Creator's Android app:**

1. Opens an outbound WebSocket connection to the relay server (`ws://relay:3002`).
2. Authenticates with the gateway JWT.
3. Reads inbound frames (recipient's IP packets) from the relay WebSocket.
4. For each IP packet:
   - Opens a **regular Java/Kotlin socket** for the destination address/port.
   - Calls `VpnService.protect(socket)` to exempt this socket from the VPN. **This is the critical step** — without it, the socket would loop through any VPN the device has active.
   - Writes the payload, reads the response.
   - Sends the response back to the relay as a DATA frame addressed to the recipient's tunnel identifier.
5. Manages a small connection pool (TCP) or sends individual datagrams (UDP).

**Why this works:**

- No root required.
- `VpnService.protect()` is available to any app holding `BIND_VPN_SERVICE` permission.
- The relay delivers recipient packets → creator processes them through protected sockets → internet response returns → relay delivers back.

**What the creator app needs:**
```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<service android:name=".GatewayService"
         android:permission="android.permission.BIND_VPN_SERVICE">
  <intent-filter>
    <action android:name="android.net.VpnService" />
  </intent-filter>
</service>
```

The `GatewayService` does NOT need to call `Builder.establish()` (it doesn't create a VPN for itself). It only uses `VpnService.protect()` to mark its relay socket as exempt. This approach is used by apps like Shadowsocks and Outline.

**Limitations:**

| Limitation | Impact | Mitigation |
|---|---|---|
| Battery drain (continuous socket polling) | Medium | Implement `Doze` exemption, use foreground service notification |
| TCP-over-TCP degradation | Medium | Prefer UDP transport for the relay where available |
| Carrier NAT blocks inbound UDP | Common | Relay server initiates the connection; creator connects out |
| Android kills background services | High | Use `startForeground()` with persistent notification |
| Mobile data throttling / carrier restrictions | Operator-dependent | Document limitation; cannot mitigate |

---

## 4. Recipient Side — Routing Traffic Through the Creator

The recipient uses `VpnService` in its standard mode:

1. Calls `VpnService.Builder.establish()` → gets `ParcelFileDescriptor` for the tun interface.
2. Configures routes: `addRoute("0.0.0.0", 0)` to capture all traffic.
3. Sets DNS: `addDnsServer("1.1.1.1")`.
4. Opens a protected WebSocket to the relay (`VpnService.protect(relaySocket)`).
5. Read loop:
   - Reads an IP packet from the tun fd → wraps in a DATA frame → sends to relay.
   - Reads a DATA frame from relay → writes the response IP packet to the tun fd.

This is functionally equivalent to a WireGuard or SOCKS5 VPN tunnel and requires no root access. The WireGuard Android app uses exactly this pattern with crypto added on top.

---

## 5. DNS Handling

The creator-side gateway must handle DNS separately:

- Recipient's DNS queries arrive as UDP port 53 packets.
- Creator opens a protected UDP socket, sends the DNS query from its own connection, returns the response.
- The relay server can optionally host a forwarding DNS resolver to reduce round trips.

---

## 6. NAT Traversal

Direct peer-to-peer (P2P) connectivity between creator and recipient was evaluated:

| Technique | Feasibility on Android | Notes |
|---|---|---|
| STUN/ICE hole-punching | Partial | Works for symmetric-symmetric NAT ~40% of time |
| TURN relay fallback | Full | Requires dedicated relay; what we implement |
| UPnP port mapping | Unreliable | Android cannot request UPnP; router-dependent |
| IPv6 direct connect | Possible | Only if both devices have routable IPv6; rare on mobile |

**Decision**: Implement relay-first architecture. P2P optimisation can be added in a later version using WebRTC ICE/TURN negotiation.

---

## 7. Proof of Concept Checklist

Before full production deployment, the following must be validated on real Android hardware:

| Test | Expected Result |
|---|---|
| 1. Creator Android app connects to relay | `relay:gateway-connected` logged |
| 2. Relay sends 3 verification probes, gateway ACKs all | `relay:gateway-verified`, connection transitions to READY |
| 3. Recipient Android app connects, VPN established | `tunnel:established`, connection transitions to ACTIVE |
| 4. `curl ifconfig.me` from recipient device returns creator's public IP | Pass |
| 5. DNS: `nslookup google.com` resolves via creator's DNS | Pass |
| 6. TCP: `curl https://example.com` succeeds | Pass |
| 7. UDP: traceroute first hop is creator's gateway | Pass |
| 8. HTTPS: TLS handshake completes, no MITM warnings | Pass |
| 9. Creator disconnects → recipient gets `tunnel:reconnecting` event | Pass |
| 10. Recipient reconnects within 30 s → session resumes | Pass |
| 11. Creator revokes participant → recipient's VPN drops immediately | Pass |
| 12. Session expires → both sides notified | Pass |

---

## 8. Architecture Diagram

```
Creator's Android device                    Recipient's Android device
─────────────────────────                   ─────────────────────────
[Cellular / WiFi]                           [Cellular / WiFi]
      │                                           │
[GatewayService]                           [TunnelService]
(VpnService subclass)                      (VpnService + tun fd)
      │                                           │
      │  WebSocket (outbound, protected)          │  WebSocket (outbound, protected)
      ▼                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│               ConnectShare Relay Server :3002                    │
│                                                                  │
│  [gateway registry]    [tunnel registry]    [verification]       │
│        │                     │                                   │
│        └────── route ────────┘                                   │
│                                                                  │
│  DATA frame:  recipient → relay → creator → internet            │
│  DATA frame:  internet → creator → relay → recipient            │
└──────────────────────────────────────────────────────────────────┘
      │                                           │
      │  WebSocket pub/sub                        │
      ▼                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              ConnectShare API Server :3000                       │
│              (Next.js Route Handlers)                            │
│  POST /api/v1/network/gateway/verify  ← relay internal call     │
│  POST /api/v1/network/tunnel/establish ← relay internal call    │
└──────────────────────────────────────────────────────────────────┘
      │                                           │
      └─────────── Redis pub/sub ─────────────────┘
      │                                           │
      ▼                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              Realtime WebSocket Hub :3001                        │
│  (session:*, creator:*, participant:* events → client apps)      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 9. What Is and Is Not Validated on Windows (This Build Host)

| Component | Validated on Windows | Requires Linux/Android |
|---|---|---|
| Key generation (X25519, AES-GCM) | ✅ (smoke tested) | — |
| JWT sign/verify | ✅ | — |
| Relay frame protocol (binary framing) | ✅ (unit-testable) | — |
| Relay WebSocket server start | ✅ (tsx relay/server.ts) | — |
| wg-quick config assembly | ✅ | — |
| Actual WireGuard tunnel (wg-quick up) | ❌ | Linux + kernel module |
| VpnService gateway on creator Android | ❌ | Android device + app |
| VpnService tunnel on recipient Android | ❌ | Android device + app |
| Packet forwarding through relay | ❌ | Real network + both devices |
| NAT egress via creator's connection | ❌ | Creator device online |
| `curl ifconfig.me` shows creator IP | ❌ | End-to-end test required |

---

## 10. References

- [Android VpnService documentation](https://developer.android.com/reference/android/net/VpnService)
- [wireguard-android user-space implementation](https://git.zx2c4.com/wireguard-android)
- [Outline SDK (user-space forwarding reference)](https://github.com/Jigsaw-Code/outline-sdk)
- [Shadowsocks-Android (VpnService.protect() pattern)](https://github.com/shadowsocks/shadowsocks-android)
- [WebRTC TURN/STUN for NAT traversal](https://webrtc.org/getting-started/turn-server)
