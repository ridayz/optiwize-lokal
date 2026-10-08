# Optiwize Lokal (mini clone OptiWize.cloud)

Port: **8932**. Stack: Node stdlib + `node:sqlite` (sama kayak tiket-app). Demo credentials only.

## Fitur hasil deepdive OptiWize.cloud → diimplementasi lokal
- **Device onboarding**: satu per satu (bulk = tambah cepat via API). Mode `demo` / `real` (RouterOS REST `/rest/...`).
- **Centralized backup**: snapshot manual + auto-daily, retensi 30 hari, diff antar revisi, one-click restore (simulated; mode real = paste ke terminal).
- **Monitoring**: poller 60 detik (reachable, latency, cpu, mem, uptime), summary, alert auto (offline / cpu>90%).
- **Templates**: atomic config + variabel `{{WAN}}`, apply per device, log tercatat.
- **Troubleshooting**: resource + log tanpa SSH (mode real via REST, demo simulated).
- **API-first**: semua panel ada REST-nya. Single-tenant disederhanakan (skema siap multi-tenant).
- **Belum**: Web Winbox full (butuh embed), Marketplace (SD-WAN/CHR/Content Filtering/Elastic IP), ARIA AI, NIS2 pack, multi-vendor TR-069, white-label domain.

## Cara pakai mode real MikroTik
1. Aktifkan REST API di RouterOS: `/ip service enable api` + `www` (port 80) atau `www-ssl`.
2. Tambah device mode=real, api_port sesuai, user punya akses api+read+policy.
3. Test via tombol Test / `POST /api/devices/:id/test`.

Password disimpan base64 (demo-only, jangan untuk produksi).
