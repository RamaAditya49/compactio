# compactio — Blueprint

> **System 1 untuk coding agent kamu.**
> LLM berpikir. compactio memutuskan. Kode mengeksekusi.

Status: blueprint v1 · 25 Sep 2026 · engine default: Jev (TypeSafe AI)

---

## 1. Ide dalam satu paragraf

Daniel Kahneman membagi pikiran menjadi dua. **System 1** cepat, murah, dan otomatis.
**System 2** lambat, mahal, dan penuh pertimbangan. Coding agent hari ini memakai System 2
untuk semua hal. Agent membawa setiap output tool ke setiap turn. Agent baru membuang konteks
saat konteks hampir penuh, dan membuangnya dengan satu prompt ringkasan yang mahal.
compactio memasang **System 1** di depan LLM. Setiap keputusan kecil ("output ini masih
perlu?", "file ini sudah dibaca?", "tugas ini butuh model generatif?") dijawab oleh model
keputusan dalam milidetik. LLM hanya menerima yang perlu.

---

## 2. Masalah (dengan bukti)

| Masalah | Bukti |
|---|---|
| Output tool memenuhi konteks | Tool result = **49,7%** isi konteks Claude Code (profil ctxlens). Snapshot Playwright 56 KB, 20 issue GitHub 59 KB (context-mode). |
| Setiap token dibayar ulang tiap turn | **97,2%** token yang ditagih adalah cache read (sampel 165,9 juta token, devxlabs.ai). Token basi ikut dibayar di setiap turn berikutnya. |
| Compact datang terlambat dan mahal | Docs Claude Code: `/compact` "is itself a large request". Auto-compact baru jalan dekat batas. |
| Kualitas turun setelah compact | Issue claude-code #6354, #9796, #32678: CLAUDE.md dan aturan hilang. |
| File dibaca berulang | Issue #11487 (loop baca ulang), #72417 (ribuan token terbuang). |
| Konteks panjang menurunkan kualitas | Chroma "Context Rot": 18 LLM menurun saat input panjang. |
| Kuota habis cepat | claude-code #16157 (1.497 komentar), #38335. codex #14593 (630 komentar). |

**Inti masalah:** agent tidak punya System 1. Semua keputusan kecil memakai model besar
atau aturan kaku.

---

## 3. Peta pesaing — dan celahnya

| Tool | Cara kerja | Celah |
|---|---|---|
| **rtk** (81,7k ★) | Hook PreToolUse menulis ulang perintah Bash. Filter aturan tetap per perintah. | Tidak menyaring `Read`, `Grep`, `Glob`. Aturan tidak tahu tugas yang sedang jalan. |
| **fast-jev-compaction** (6,8k ★) | Mengganti ringkasan compact dengan keputusan Jev (2 `noul` per tool call). | Lihat tabel cacat di bawah. |
| caveman (107k ★), ponytail (145k ★) | Prompt/skill agar output singkat. | Hanya prompt. Tidak menyentuh output tool. |
| context-mode (24k ★) | Sandbox MCP, output mentah di luar konteks. | LLM harus memilih tool-nya sendiri. |
| claude-mem (94k ★) | Kompres sesi dengan LLM untuk sesi berikutnya. | Pakai LLM generatif untuk meringkas. |
| ±20 plugin Jev lain (Codex, OpenCode, Pi, Hermes) | Salinan pola compact saat penuh. | Satu host per repo. Pola yang sama, cacat yang sama. |

### Cacat fast-jev-compaction (dari issue tracker-nya sendiri)

| # | Cacat | Bukti | Jawaban compactio |
|---|---|---|---|
| 1 | Jev membuang hampir semua. Jawaban palsu "0 untuk semua" = 88,5% reduksi, Jev asli = 87,7%. AUC 0,54–0,66. | #26, #52, #56 | Kirim **preview isi** output, bukan catatan ukuran. Kalibrasi threshold dari data berlabel. |
| 2 | Model mengarang "pekerjaan selesai" setelah call dibuang. | #65 | **Tombstone** di tempat call yang dibuang. |
| 3 | Hemat hilang saat `--resume` (28k → 166k). | #89 | Jangan hanya bergantung pada compact. Saring di sumber (per tool) dan di proxy. |
| 4 | Firewall Cloudflare TypeSafe menolak state berisi shell/SQL/path (HTML 403). Fallback diam-diam. | #97 | Redaksi + normalisasi state. Fallback **selalu terlihat** di scoreboard. |
| 5 | Seluruh riwayat dikirim ke pihak ketiga tanpa redaksi. | #64, #88, #98 | Redaksi secret di lokal sebelum kirim. |
| 6 | Hanya Claude Code, pakai function hooks early access. | #21, #76 | Adapter multi-host dari hari pertama. |

**Posisi compactio:** bukan "compact yang lebih cepat". compactio membuat compact **jarang perlu**.

---

## 4. Arsitektur: tiga organ System 1

```
 prompt user
     │
     ▼
┌─────────────┐  "Butuh generatif? Model apa? Konteks apa?"
│  1. GERBANG │──── jawaban deterministik / routing model
└─────────────┘
     │
     ▼
   LLM (System 2) ──► tool call
                          │
                          ▼
                   ┌─────────────┐  "Output ini: utuh / potong / tanda tangan / buang?"
                   │ 2. SARINGAN │──── + dedupe baca ulang (kode murni)
                   └─────────────┘
                          │
     ┌────────────────────┘
     ▼
┌─────────────┐  "Mana konteks lama yang sudah basi?"
│  3. SAPU    │──── buang per blok, pasang tombstone, jaga prompt cache
└─────────────┘
```

Aturan pembagian kerja (dari pola TypeSafe):

- **Kode** mengerjakan yang pasti: hash file, dedupe, batas ukuran, redaksi.
- **Jev** mengerjakan yang butuh penilaian: relevan atau tidak, level simpan, rute.
- **LLM** hanya menulis: rencana, kode, jawaban.

### 4.1 Saringan (per tool call) — organ utama, rilis pertama

Jalan setelah tool selesai, sebelum model melihat output.

1. **Kode dulu.** Output lewat filter deterministik: strip ANSI, lipat baris berulang,
   ringkas stack trace, ringkas output test ke yang gagal saja. Kompatibel dengan rtk.
2. **Dedupe baca ulang.** Hash isi file. File sama dan belum berubah →
   `[compactio: foo.ts tidak berubah sejak turn 12, 340 baris]`. Tanpa panggil Jev.
3. **Jev memutuskan level simpan** dengan satu `choice`:
   - `full` — output relevan untuk tujuan saat ini.
   - `focus` — simpan bagian yang cocok dengan tujuan (baris yang dipilih Jev per chunk).
   - `headtail` — simpan awal + akhir.
   - `stub` — simpan satu baris ringkasan struktural (dibuat oleh kode).
   State berisi: tujuan (prompt user terakhir), nama tool + input, **preview isi**
   (head + tail + baris yang cocok), ukuran.
4. **Confidence rendah → `full`.** Salah simpan lebih murah daripada salah buang.
5. Output asli disimpan lokal. Model bisa ambil lagi lewat `compactio show <id>`.

Tidak semua output dikirim ke Jev. Output kecil (< 2 KB) lewat langsung. Hemat datang dari
output besar.

### 4.2 Sapu (konteks lama) — rilis kedua

Jalan tiap N turn, bukan tiap turn.

- Jev menilai setiap tool result lama dengan `score` 4 level terhadap tujuan saat ini.
  Semua pertanyaan dalam **satu request** (Jev menjawab paralel: 13 pertanyaan 0,27 s).
- Result basi diganti **tombstone**:
  `[compactio: output Read src/db.ts (turn 8) dibuang — jalankan ulang bila perlu]`.
  Teks asisten yang menyebut call itu tetap punya jangkar. Ini menutup cacat #2.
- **Jaga prompt cache.** Cache read = 97% tagihan. Buang konteks di tengah prefix membuat
  cache miss. Sapu hanya jalan saat `token_hemat × sisa_turn_estimasi > biaya_tulis_ulang_cache`.
  Buang dalam satu blok besar, jangan sedikit-sedikit.
- Jalur per host: proxy lokal (Claude Code, Codex), hook `messages.transform` (OpenCode),
  `BeforeModel` (Gemini CLI).

### 4.3 Gerbang (awal tiap prompt) — rilis ketiga

Satu request Jev dengan beberapa pertanyaan paralel:

| Pertanyaan | Tipe | Aksi |
|---|---|---|
| Tugas ini butuh model generatif? | `noul` | Tidak → jalankan jalur deterministik (mis. "jalankan test", "status git") bila host mengizinkan. |
| Model mana yang cukup? | `choice` (fast / powerful) | Proxy mengarahkan request ke model yang lebih murah. |
| Konteks apa yang perlu? | `choice` per paket | Tambah hanya paket konteks yang relevan (`additionalContext`). |

Jujur soal batas: hanya Gemini CLI (`BeforeModel` → `llm_response`) dan mode proxy yang
bisa **melewati** model. Host lain hanya bisa menambah konteks atau memblokir prompt.

---

## 5. Matriks host

| Host | Saringan | Sapu | Gerbang | Jalur |
|---|---|---|---|---|
| **Claude Code** | ✅ `PostToolUse.updatedToolOutput` (semua tool) | proxy | `UserPromptSubmit` + proxy | plugin `.claude-plugin` |
| **Codex CLI** | ✅ `postToolUse` `decision:block`+`reason` | proxy | `userPromptSubmit` + proxy | plugin `.codex-plugin` |
| **OpenCode** | ✅ `tool.execute.after` | ✅ `messages.transform` | `chat.message` | paket npm |
| **Gemini CLI** | ✅ `AfterTool` | ✅ `BeforeModel` | ✅ bisa lewati model | extension |
| **Cursor** | ⚠️ tulis ulang perintah (PreToolUse) + MCP | — | — | `.cursor-plugin` |
| **Trae** | ⚠️ tulis ulang perintah | — | — | `hooks.json` |
| **ZCode, Windsurf** | ⚠️ server MCP `compactio_exec` saja | — | — | MCP |

Jalur cadangan untuk semua host: **tulis ulang perintah** (`compactio run -- <cmd>`),
pola yang sama dengan rtk.

---

## 6. Keputusan teknis

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Bahasa | TypeScript + Bun, dikompilasi jadi satu binary | SDK Jev resmi JS (`@typesafe-ai/sdk`). OpenCode plugin = npm. Nama npm `compactio` sudah milik kita. |
| Engine | Jev `jev-1.13.0` (pin versi). Lewat TypeSafe API atau OpenRouter. | $0,042 / 1 juta token input, output gratis. |
| Batas request | State + pertanyaan ≤ 64k token, state + pertanyaan terpanjang ≤ 32k. | Batas resmi Jev. Batching otomatis. |
| Gagal | **Fail-open**: output asli lewat, kejadian dicatat, terlihat di scoreboard. | Agent tidak boleh rusak karena compactio. |
| Timeout | 1,5 s per keputusan, lalu fail-open. | Hook Claude Code default 30 s, kita jauh di bawah. |
| Privasi | Redaksi secret (pola key, token, `.env`) di lokal. Mode `--local-only` = hanya filter kode. | Menutup cacat #4 dan #5. |
| Penyimpanan | `~/.compactio/` : output asli, hash file, log keputusan (JSONL). | Bisa diaudit, bisa diputar ulang untuk eval. |
| Konfigurasi | Satu file `compactio.toml`, default yang aman. | Nol konfigurasi untuk mulai. |

Struktur repo:

```
compactio/
  src/core/       # saringan, sapu, gerbang, redaksi, dedupe
  src/engine/     # klien Jev + batching + cache keputusan
  src/hosts/      # claude-code, codex, opencode, gemini, cursor, trae, mcp
  src/cli/        # install, run, show, gain, proxy, eval
  eval/           # replay sesi nyata + benchmark A/B
```

---

## 7. Angka jujur (aturan wajib)

Klaim "ratusan kali" hanya benar untuk **biaya per keputusan** (Jev vs LLM).
Klaim tagihan total harus diukur end-to-end.

`compactio gain` menampilkan per sesi dan total:

```
compactio · sesi ini
  token dicegah masuk konteks   912.408
  token dibayar ulang dicegah   14,2 jt   (≈ $21,30)
  biaya Jev                     $0,011
  keputusan                     1.204  (fail-open: 3)
  rasio hemat                   1.936×  biaya keputusan
```

Benchmark publik (wajib sebelum launch):

- A/B berpasangan pada subset SWE-bench Verified: **token, biaya, dan tingkat sukses tugas**.
- Pembanding: tanpa plugin, rtk, fast-jev-compaction, compactio, compactio + rtk.
- Uji "jawaban palsu": bandingkan dengan baseline "buang semua" dan "head+tail".
  Kalau compactio tidak mengalahkan baseline, jangan klaim.

---

## 8. Roadmap

| Versi | Isi | Selesai bila |
|---|---|---|
| **v0.1** | Claude Code: Saringan (PostToolUse) + dedupe baca ulang + `compactio gain` + fail-open + redaksi | Replay 20 sesi nyata: reduksi ≥ 50% token tool, sukses tugas tidak turun. |
| **v0.2** | Codex, OpenCode, Gemini CLI + jalur tulis ulang perintah (Cursor, Trae) + MCP fallback | 1 perintah install per host. |
| **v0.3** | Sapu: proxy lokal (opt-in) + hook OpenCode/Gemini + tombstone + penjaga cache | Compact otomatis jarang terjadi pada sesi 4 jam. |
| **v0.4** | Gerbang: routing model + skip generatif (Gemini, proxy) | Biaya per tugas turun tanpa sukses turun. |
| **v1.0** | Benchmark publik + launch | Angka terbukti dan bisa direproduksi. |

---

## 9. Rencana viral

**Hook utama:** *"Your coding agent thinks with System 2 for everything. Give it a System 1."*

1. **Demo 15 detik:** sesi Claude Code nyata, `compactio gain` naik real-time, speed 1×.
2. **Satu kalimat install:** *"ask your agent to install compactio"* + `npx compactio install`.
3. **Thread peluncuran:** Kahneman → masalah (angka §2) → 3 organ → benchmark jujur → link.
4. **Tag:** @typesafeai (mereka repost integrasi), @altryne, @tamarajtran. Kredit "powered by Jev".
5. **Kawan, bukan lawan:** "works with rtk" — compactio menyaring yang rtk tidak jangkau.
6. **Screenshot scoreboard** mudah dibagikan. Angka dolar, bukan persen.
7. **Kanal:** X, Show HN ("System 1 for coding agents"), r/ClaudeAI, r/LocalLLaMA, Product Hunt.
8. **Bahasa global:** README Inggris. Satu `README.id.md` untuk komunitas lokal.

---

## 10. Risiko

| Risiko | Mitigasi |
|---|---|
| Bergantung pada TypeSafe (harga, API, firewall) | Pin versi model. Jalur OpenRouter. Mode `--local-only`. Interface engine satu lapis. |
| Salah buang → agent bingung atau mengarang | Confidence rendah = simpan. Tombstone. Output asli bisa diambil lagi. |
| Cache miss menaikkan tagihan | Penjaga cache di Sapu (§4.2). Ukur di benchmark. |
| API hook host berubah | Adapter tipis per host. Test kontrak per host. |
| Privasi kode klien | Redaksi lokal, mode lokal, dokumentasi data yang dikirim. |
| Pesaing menyalin | Kecepatan rilis + benchmark publik + multi-host. |

---

## 11. Keputusan yang sudah diambil

- Nama: **compactio**. npm `compactio` terdaftar, repo `RamaAditya49/compactio` (private).
- Framing: **System 1** (Kahneman), bukan "System One" (istilah produk TypeSafe).
- Engine default: Jev, dengan kredit "powered by Jev".
- Mode proxy: **ya, opt-in**, di v0.3. Tanpa proxy, Sapu tidak bisa jalan di Claude Code dan Codex.

## Sumber

docs.typesafe.ai (api.md, models.md, concepts/system-one.md) · github.com/tamaratran/fast-jev-compaction
(issues #26 #52 #56 #65 #89 #97) · github.com/rtk-ai/rtk · code.claude.com/docs/en/hooks, /costs ·
learn.chatgpt.com/docs/hooks · opencode.ai/docs/plugins · geminicli.com/docs/hooks/reference ·
cursor.com/docs/agent/hooks · zcode.z.ai/en/docs/hooks · trychroma.com/research/context-rot ·
devxlabs.ai/blogs/how-claude-code-actually-works
