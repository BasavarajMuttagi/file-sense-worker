<div align="center">
  <img src="https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/layers.svg" alt="FileSense Logo" width="64" height="64" />

  # FileSense

  **Document Intelligence & Hybrid RAG Engine**

  *A high-throughput, edge-native document intelligence platform designed to eliminate hallucinations through hybrid vector retrieval, verified page citations, and real-time architecture diagramming.*

  <br />

  [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-workerd-F38020?logo=cloudflare&logoColor=white&style=flat-square)](https://workers.cloudflare.com/)
  [![Hono](https://img.shields.io/badge/Hono-v4.12-E36002?logo=hono&logoColor=white&style=flat-square)](https://hono.dev/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white&style=flat-square)](https://www.typescriptlang.org/)
  [![Drizzle ORM](https://img.shields.io/badge/ORM-Drizzle_v1--rc-C5F74F?logo=drizzle&logoColor=black&style=flat-square)](https://orm.drizzle.team/)
  [![Turso Database](https://img.shields.io/badge/Database-Turso_LibSQL-4FF8D2?logo=turso&logoColor=black&style=flat-square)](https://turso.tech/)
  [![Upstash Vector](https://img.shields.io/badge/Vector-Upstash_Hybrid_DBSF-00E599?style=flat-square)](https://upstash.com/docs/vector/overall/whatisvector)
  [![Upstash Box](https://img.shields.io/badge/Compute-Upstash_Box_Sandbox-00E599?style=flat-square)](https://upstash.com/docs/box)
  [![Tigris Storage](https://img.shields.io/badge/Storage-Tigris_S3-FF4F81?style=flat-square)](https://www.tigrisdata.com/)
  [![Mistral AI](https://img.shields.io/badge/LLM-Mistral_AI-FF7000?style=flat-square)](https://mistral.ai/)
  [![Sarvam AI](https://img.shields.io/badge/OCR-Sarvam_DocAI-4A72FF?style=flat-square)](https://sarvam.ai/)
  [![Clerk Auth](https://img.shields.io/badge/Auth-Clerk-6C47FF?logo=clerk&logoColor=white&style=flat-square)](https://clerk.com/)

</div>

<div>
  <img width="1470" height="846" alt="FileSense Workspace" src="https://github.com/user-attachments/assets/616f0053-e0e1-4307-af07-28f8223065ef" />
  <img width="1469" height="841" alt="FileSense Realtime Citations" src="https://github.com/user-attachments/assets/acca9fbb-95a7-4ca5-bd43-0b0809e96cbd" />
</div>

---

## 💡 What is FileSense?

**FileSense** is an enterprise-grade document intelligence workspace and hybrid Retrieval-Augmented Generation (RAG) platform. Built on Cloudflare Workers and distributed serverless infrastructure, it allows engineering, legal, research, and product teams to ingest massive multi-format document vaults and query them with absolute grounding and zero hallucinations.

Standard AI chatbots frequently suffer from semantic drift, hallucinate critical figures, obscure page references, and bottleneck on slow monolithic API gateways. FileSense eliminates these flaws by combining:
1. **Hybrid Vector Retrieval** with **Distribution-Based Score Fusion (DBSF)** for sub-15ms semantic and keyword matching.
2. **Serverless Ephemeral Compute Sandboxes** for non-blocking OCR and deterministic document vectorization.
3. **Strict Page-Boundary Context Windows** delivering verified citations with instant chunk inspectors.
4. **Real-time Mermaid Architecture Synthesis** automatically generating executable flowcharts and sequence diagrams in live chat streams.

---

## 🎯 The Core Problems FileSense Solves

| Problem in Traditional Document AI | How FileSense Solves It |
|---|---|
| **Semantic Drift & Keyword Blindness** | Merges dense embeddings (`text-embedding-3-small`, 1536d) with sparse lexical BM25 token frequencies via Distribution-Based Score Fusion (DBSF), ensuring exact technical acronyms, method signatures, and conceptual meaning match simultaneously. |
| **Hallucinations & Ungrounded Answers** | If no retrieved chunks exceed confidence thresholds, the system immediately returns a transparent guardrail notice rather than synthesizing fictitious information. |
| **Opaque, Unverifiable References** | Every response synthesizes inline bracket citations (`[1]`, `[2]`) linked to verified document metadata, exact page numbers, chunk positions, and normalized match confidence percentages. |
| **Ingestion Bottlenecks & Timeouts** | Direct client-to-storage uploads via presigned S3 URLs bypass worker memory limits. Heavy OCR and chunking are offloaded asynchronously to an isolated container sandbox via S3 bucket event webhooks. |
| **Static Text-Only Explanations** | Translates technical document relationships, system architectures, and workflows into reactive, rendered Mermaid.js diagrams directly within the chat stream. |
| **Cross-Tenant & Project Contamination** | Multi-tenant isolation at every layer: user data is partitioned in Turso, vectors are scoped by user and project ID in Upstash, and documents are vaulted in private S3 namespaces. |

---

## 🏗️ System Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENT TIER (React 19 + Vite)                                  │
│   • Tiimo-Inspired Editorial UI    • Throttled RAF Token Buffer (60fps)    • Clerk Session Auth  │
└────────────────────────────────┬───────────────────────────────────────▲─────────────────────────┘
                                 │                                       │
                    [1] Direct S3 Upload (Presigned PUT)      [7] SSE Stream (Tokens + Mermaid)
                                 │                                       │
                                 ▼                                       │
┌────────────────────────────────────────────────────────────────────────┴─────────────────────────┐
│                          GLOBAL EDGE TIER (Cloudflare Workers + Hono)                            │
│   • Sub-5ms TTFB Edge Routing       • JWT Auth Middleware            • Server-Sent Events (SSE)  │
│   • Endpoints: /queries (RAG Stream) · /projects · /documents · /api/upload · /webhooks/tigris   │
└──────────────┬───────────────────────────────┬─────────────────────────▲─────────────────────────┘
               │                               │                         │
     [2] Write / Read DB            [5] Hybrid Vector Query     [6] Context Prompt
               │                       (Dense 1536d + BM25)              │
               ▼                               ▼                         ▼
┌──────────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────────────┐
│     STATE & PERSISTENCE      │ │    HYBRID VECTOR SEARCH   │ │         INFERENCE & REASONING     │
│         Turso LibSQL         │ │    Upstash Vector (DBSF)  │ │              Mistral AI           │
│   Drizzle ORM · Edge SQLite  │ │ Dense 1536d + Sparse BM25 │ │ open-mistral-nemo · mistral-small │
└──────────────▲───────────────┘ └─────────────▲─────────────┘ └───────────────────────────────────┘
               │                               │
    [4c] Update Status = processed     [4b] Upsert Chunks
               │                               │
┌──────────────┴───────────────────────────────┴───────────────────────────────────────────────────┐
│                         ASYNC INGESTION SANDBOX (Upstash Box Container)                          │
│   • Isolated Linux Container (2 vCPU, 4GB RAM)   • Triggered via Tigris S3 Bucket Webhook        │
│   • [4a] Multi-Page Layout OCR (Sarvam DocAI)    • Deterministic Overlapping Semantic Chunker   │
└──────────────────────────────────────────────▲───────────────────────────────────────────────────┘
                                               │
                                  [3] Download Original Document
                                               │
┌──────────────────────────────────────────────┴───────────────────────────────────────────────────┐
│                           DECENTRALIZED OBJECT VAULT (Tigris Data)                               │
│   • S3-Compatible Globally Distributed Storage Vault       • Event Webhook on ObjectCreated      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### End-to-End System Execution Lifecycle
1. **Direct Upload**: Browser requests a time-limited presigned PUT URL and streams the file directly to Tigris S3 without consuming Worker memory.
2. **Metadata Registration**: Tigris triggers the `/webhooks/tigris` endpoint upon upload completion, writing initial document metadata to Turso LibSQL.
3. **Async Sandbox Spawn**: The worker dispatches an isolated Linux container on Upstash Box (`waitUntil` execution context).
4. **Extraction & Hybrid Indexing**:
   - Upstash Box downloads the raw file via presigned GET.
   - Sarvam DocAI extracts multi-page text, preserving tables and visual layout.
   - Semantic chunker segments text with 15% sliding window overlap and deterministic chunk IDs.
   - Chunks are batch-upserted to Upstash Vector (dense 1536d embeddings + BM25 sparse index).
   - Document status in Turso transitions from `processing` to `processed`.
5. **Hybrid Query Retrieval**: When a question is submitted, Upstash Vector performs hybrid search fusing dense semantic similarities and BM25 scores with Distribution-Based Score Fusion (DBSF).
6. **Context Synthesis & Visuals**: The top ranked chunks are passed to Mistral AI with strict grounding rules, synthesizing answers with page-level bracket citations (`[1]`, `[2]`) and reactive Mermaid diagrams.
7. **60fps Throttled Streaming**: Server-Sent Events (SSE) stream tokens to the React frontend, where a `requestAnimationFrame` buffer delivers smooth rendering without layout jitter.

---

## 🧩 Deep Dive: System Composition

### 1. Ingestion & Decentralized Object Vault (Tigris Data)
* **Zero Worker Overhead**: The worker issues short-lived presigned PUT URLs, allowing the browser to stream files up to 50MB directly to encrypted Tigris S3 buckets.
* **Webhook Automation**: When an upload finishes, Tigris triggers `/webhooks/tigris`, registering the document in Turso and queueing asynchronous indexing.

### 2. Ephemeral Compute Sandbox (Upstash Box)
* **Isolated Environment**: Heavy document digitization runs inside an on-demand container sandbox equipped with 2 vCPU and 4GB RAM.
* **Sarvam Doc AI OCR**: Scans multi-column PDFs, tables, and mixed media to extract structured text with layout preservation.
* **Fallback Extraction**: Built-in fallback to native PDF parsing if external OCR services are unavailable.
* **Page-Aware Chunking**: Documents are split into semantic chunks with 15% sliding window overlap, preserving headers, paragraph flow, page start/end marks, and deterministic chunk IDs.

### 3. Hybrid Retrieval Engine (Upstash Vector)
* **Dense Semantic Index**: 1536-dimensional embeddings generated by `text-embedding-3-small`.
* **Sparse Lexical Index**: Built-in BM25 scoring for exact keyword, acronym, and identifier matching.
* **Distribution-Based Score Fusion (DBSF)**: Combines dense cosine similarity and sparse BM25 scores using normal distribution normalization ($\mu \pm 3\sigma$), producing intuitive match scores between 60% and 98%.
* **Boundary Context Continuity**: Automatically detects when a retrieved chunk sits at a page boundary and injects adjacent page chunks to ensure complete multi-sentence context.

### 4. Reasoning & Visual Synthesis (Mistral AI)
* **Primary Frontier Model**: `open-mistral-nemo` (128k context window, high instruction fidelity).
* **Automatic Resilience Cascade**: If rate limits or timeouts occur, the worker immediately cascades to `mistral-small-latest`, `ministral-8b-latest`, and `mistral-large-latest`.
* **Reactive Mermaid Generation**: When describing multi-step pipelines, data schemas, architectures, or workflows, the model generates executable `flowchart TD` or `sequenceDiagram` syntax that renders interactively on the client.

### 5. High-Performance Edge Runtime (Cloudflare Workers & Hono)
* **Global Latency**: Sub-5ms initial TTFB dispatched from Cloudflare's global edge network across 300+ cities.
* **Server-Sent Events (SSE)**: Streams tokens, page citations, and lifecycle events directly to the UI with support for instant client stream cancellation.

---

## 📡 API Reference

All protected endpoints require an `Authorization: Bearer <clerk_session_token>` header.

### Projects API
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/projects` | List all projects belonging to the authenticated user |
| `POST` | `/projects` | Create a new project workspace (`{ title, description? }`) |
| `GET` | `/projects/:id` | Get project metadata and document counts |
| `PATCH` | `/projects/:id` | Update project title or description |
| `DELETE` | `/projects/:id` | Delete project and cascade-delete documents & vector embeddings |

### Documents API
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/documents` | List documents filtered by `?projectId=` query parameter |
| `GET` | `/documents/:id` | Retrieve metadata, file size, status, and chunk count for a document |
| `DELETE` | `/documents/:id` | Delete document from Turso, Tigris S3, and Upstash Vector |

### Upload & Ingestion API
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Generate presigned PUT URL for direct Tigris S3 upload |
| `POST` | `/webhooks/tigris` | Secure S3 event webhook that triggers async container indexing |

### Queries & RAG Stream API
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/queries` | Submit question; supports both JSON and Server-Sent Events (`stream: true`) |
| `GET` | `/queries` | Fetch paginated chat query history with source citations |
| `GET` | `/queries/sessions` | List all active conversation threads grouped by session |
| `DELETE` | `/queries/sessions/:sessionId`| Delete an entire conversation thread |

#### SSE Event Protocol (`POST /queries` with `stream: true`)
```
event: sources
data: [{"docId":"...","fileName":"system_spec.pdf","page":4,"score":0.88,"excerpt":"..."}]

event: token
data: {"text":"FileSense "}

event: token
data: {"text":"uses hybrid vector retrieval..."}

event: done
data: {"id":"query-uuid","sessionId":"session-123","answer":"..."}
```

---

## 🎨 Editorial Design Philosophy (Frontend)

The companion web interface breaks away from sterile enterprise dashboards, implementing a tactile, calming aesthetic inspired by **Tiimo**:

* **Typographic Harmony**:
  * **Fraunces**: A warm, high-contrast display serif for editorial headlines, project titles, and zero-state narratives.
  * **Plus Jakarta Sans**: A contemporary geometric sans-serif for responsive controls, inputs, and conversation bubbles.
  * **JetBrains Mono**: A precision monospace font for chunk indices, byte measurements, and citation match percentages.
* **Tactile Warmth**:
  * Soft cream canvas (`#FAF9F6`) and off-white card surfaces (`#F8F7F3`), completely avoiding harsh `#000000` on `#FFFFFF` contrasts.
  * Obsidian ink (`#161613`) for effortless, long-session reading comfort.
  * Pastel signals: Soft Lavender (`#E2DAFF`), Butter Yellow (`#FFF0B3`), Mint (`#D8F3E5`), and Warm Peach (`#FFD3C4`).
* **Micro-Interactions**:
  * Single-location document dropzone built directly into the chat input bar.
  * Throttled `requestAnimationFrame` token buffer maintaining smooth 60fps streaming without scrollbar jumping or layout reflows.

---

## 🛠️ Complete Technology Matrix

```
┌──────────────────────────────────────────────────────────┐
│                      FileSense UI                        │
│         React 19  ·  TypeScript 5  ·  Tailwind v4        │
│          Fraunces Display  ·  Plus Jakarta Sans          │
└─────────────┬──────────────────────────────┬─────────────┘
              │                              │
              ▼                              ▼
┌───────────────────────────┐  ┌───────────────────────────┐
│     Hybrid Vector RAG     │  │    Document Processing    │
│    Upstash Vector (DBSF)  │  │      Tigris Data S3       │
│  Dense 1536d + Sparse BM25│  │  Presigned Client Uploads │
└─────────────┬─────────────┘  └─────────────┬─────────────┘
              │                              │
              └──────────────┬───────────────┘
                             ▼
              ┌─────────────────────────────┐
              │      Reasoning & LLM        │
              │         Mistral AI          │
              │  Grounded Text + Mermaid.js │
              └─────────────────────────────┘
```

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Edge Runtime** | Cloudflare Workers (`workerd`) | Latest | Low-latency global edge API execution |
| **HTTP Framework** | Hono | `^4.12.12` | Lightweight edge-native routing and SSE streaming |
| **Database** | Turso (LibSQL) | `^0.18.0` | Distributed edge SQLite database |
| **ORM** | Drizzle ORM | `^1.0.0-rc.4` | Type-safe SQL query builder and schema management |
| **Vector Engine** | Upstash Vector | `^1.2.3` | Hybrid dense + BM25 vector search with DBSF fusion |
| **Compute Sandbox**| Upstash Box | `^0.7.2` | On-demand Linux container for document OCR and chunking |
| **Object Storage** | Tigris Data | `^3.21.0` | S3-compatible globally distributed object store |
| **Inference Model**| Mistral AI | `^2.6.4` | Grounded reasoning, synthesis, and Mermaid generation |
| **Document OCR**   | Sarvam DocAI | `^1.1.9` | Layout-aware document digitization and OCR |
| **Authentication** | Clerk | `^0.1.76` | JWT edge verification and user identity |
| **Validation**     | Zod | `^4.3.6` | Runtime request body and parameter validation |

---

## 🚀 Quickstart & Local Development

### 1. Prerequisites
* [Node.js](https://nodejs.org/) (v20 or later)
* [Cloudflare Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
* Accounts for Cloudflare, Clerk, Turso, Tigris Data, Upstash, and Mistral AI

### 2. Clone & Install Dependencies
```bash
git clone https://github.com/your-username/file-sense-worker.git
cd file-sense-worker
npm install
```

### 3. Configure Environment Variables
Create a `.env` file in the root directory:
```env
# Vector & Ephemeral Compute
UPSTASH_VECTOR_REST_URL="https://your-vector-index.upstash.io"
UPSTASH_VECTOR_REST_TOKEN="your-upstash-vector-token"
UPSTASH_BOX_API_KEY="your-upstash-box-api-key"

# Authentication
CLERK_PUBLISHABLE_KEY="pk_test_..."
CLERK_SECRET_KEY="sk_test_..."

# Storage (Tigris S3)
TIGRIS_STORAGE_ACCESS_KEY_ID="tid_..."
TIGRIS_STORAGE_SECRET_ACCESS_KEY="tsec_..."
TIGRIS_STORAGE_ENDPOINT="https://t3.storage.dev"
TIGRIS_STORAGE_BUCKET="filesense-bucket"

# Database (Turso LibSQL)
DATABASE_URL="libsql://your-database.turso.io"
TOKEN="your-turso-auth-token"

# AI Inference & OCR
MISTRAL_API_KEY="your-mistral-api-key"
SARVAM_API_KEY="your-sarvam-api-key"
```

### 4. Database Migrations
Generate and push the Drizzle schema to your Turso edge database:
```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

### 5. Run Local Edge Development Server
```bash
npm run dev
# Starts local workerd instance at http://localhost:8787
```

### 6. Deploy to Cloudflare Workers
Upload secrets to Cloudflare Workers and deploy globally:
```bash
npm run secrets:upload
npm run deploy
```

---

## 🔒 Security & Data Privacy

* **Zero Model Retraining**: Document chunks and vector embeddings are private and strictly isolated. They are never transmitted for model training or weight adjustments.
* **Strict Tenant Isolation**: All database records, storage paths, and vector payloads are partitioned by `userId` and `projectId`.
* **Ephemeral Presigned Uploads**: Documents upload directly to encrypted Tigris S3 buckets via time-limited presigned URLs with 15-minute expiration windows.
* **Isolated Container Execution**: Heavy extraction occurs inside isolated sandboxes (Upstash Box) with temporary memory storage immediately cleared upon job termination.

---

<div align="center">
  <sub>Engineered for speed, precision, and zero hallucinations. Built with Cloudflare Workers, Hono, Upstash, and Mistral AI.</sub>
</div>
