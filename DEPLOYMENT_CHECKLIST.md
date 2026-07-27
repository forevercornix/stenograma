# Rizikų mažinimo kontrolinis sąrašas

Šis dokumentas surikiuoja visas README/backend README paminėtas žinomas rizikas pagal
**diegimo scenarijų**, nes dauguma jų aktualios tik kai kuriems naudojimo būdams. Jei
naudojate lokaliai/portfolio tikslais, beveik nieko keisti nereikia. Jei planuojate viešą
production diegimą - žemiau konkretus, prioritetais surikiuotas veiksmų sąrašas.

---

## Scenarijus A: Lokalus kūrimas / portfolio demo

**Veiksmų nereikia.** Numatytos reikšmės (`docker-compose.yml`, `.env.example`) jau
saugios šiam naudojimui:
- `TRANSCRIPTION_PROVIDER=mock`, `LLM_PROVIDER=mock` - be jokių raktų.
- Docker prievadai susieti su `127.0.0.1` - nepasiekiami iš išorės.
- `NODE_ENV=development` - patogu, nes `/api/audit` ir autentifikacija neblokuoja lokalaus darbo.

Vienintelis dalykas, į kurį verta atkreipti dėmesį: jei įrašysite realų `ANTHROPIC_API_KEY`
į `.env`, kad išbandytumėte tikrą LLM lokaliai - tai vis tiek saugu, nes prievadai
uždaryti nuo išorės (žr. Scenarijų B/C, jei tai nebe tik jūsų mašina).

---

## Scenarijus B: Vidinis naudojimas (komanda, intranet/VPN)

Tinka, kai visi naudotojai yra patikimame tinkle (biuro Wi-Fi, VPN), bet backend'as
pasiekiamas daugiau nei vienam žmogui.

**Būtina prieš paleidžiant:**

1. **Nustatykite `API_KEY`** (bendras raktas komandai) ir `NODE_ENV=production`, kad
   endpoint'ai neliktų atviri be jokio patikrinimo. Pasidalinkite raktu per saugų kanalą
   (ne el. paštu/Slack'e atviru tekstu, jei įmanoma - naudokite slaptažodžių tvarkyklę).
2. **`AUDIT_API_KEY`** - atskiras raktas, jei norite, kad kas nors iš komandos galėtų
   žiūrėti `/api/audit` (kainas, klaidas). Kitaip palikite `NODE_ENV=production` uždarytą.
3. **`CORS_ORIGIN`** - nustatykite į tikrą vidinį adresą (ne `http://localhost:5173`,
   jei frontend'as bus pasiekiamas kitu vardu/IP).
4. **`HEALTH_DETAILS=hidden`**, nebent komandai patogu matyti, koks tiekėjas naudojamas.
5. Jei naudojate `VITE_API_KEY` fronte - įsitikinkite, kad tinklas TIKRAI patikimas
   (VPN/intranet), nes raktas bus matomas kiekvienam su prieiga prie JS bundle'o.

   ⚠️ **SVARBU dėl `VITE_API_KEY` prigimties:** tai **bendras diegimo sekretas / bazinis
   prieigos barjeras, NE galutinio vartotojo autentifikacija** (*shared deployment secret /
   basic access barrier, not end-user authentication*). Kadangi raktas patenka į viešą JS
   bundle: (a) bet kuris vartotojas gali jį nuskaityti; (b) jis negali atskirti vartotojų
   vieno nuo kito; (c) atšaukimas paveiktų VISUS; (d) nėra sesijų, teisių ar audito pagal
   tapatybę. Lokaliam sekretoriaus diegimui arba už VPN - priimtina. **Viešam serveriui su
   keliais vartotojais - NE:** tokiu atveju reikia tikros autentifikacijos (žr. lentelę
   žemiau - OIDC/sesijos vietoj bendro rakto).

**Nebūtina, bet verta apsvarstyti:**
- Padidinti `MAX_UPLOAD_MB`, jei įrašai ilgesni nei numatyti 50MB.
- Sumažinti `RATE_LIMIT_MAX_REQUESTS`, jei norite griežčiau kontroliuoti LLM išlaidas.
- Periodiškai perleisti (restart) backend'ą arba stebėti `utils/jobStore.js` dydį -
  jis auga atmintyje tarp restart'ų (TTL išvalo pasibaigusius jobus, bet procesas vis
  tiek turėtų būti restartuojamas periodiškai gerai higienai).

---

## Scenarijus C: Viešas production diegimas (realūs, nepažįstami vartotojai)

Tai scenarijus, kuriam šis projektas **NĖRA** paruoštas be papildomo darbo. Žemiau -
prioritetais surikiuotas planas, ką reikia padaryti PRIEŠ tokį diegimą.

### 1 prioritetas - be šito NESKELBTI viešai

| Rizika | Veiksmas |
|---|---|
| Bendras `API_KEY`, ne per-user auth | Įdiekite tikrą autentifikaciją (sesijos + slaptažodis, arba OAuth/OIDC per Auth0/Clerk/pan.) prieš `middleware/apiKeyAuth.js` arba vietoj jo. Kiekvienas vartotojas turi savo identitetą, ne bendrą raktą. |
| Docker prievadai / tinklo topologija | Niekada neatidarykite backend'o prievado tiesiogiai internetui. Statykite reverse proxy (nginx/Caddy/Cloudflare Tunnel) su TLS priešais, o Docker prievadus palikite susietus su `127.0.0.1` (jau numatyta). |
| Rate limiting tik pagal IP | Papildykite rate limiting pagal VARTOTOJO ID (ne tik IP - NAT'as gali sujungti daug vartotojų po vienu IP arba atskirti vieną vartotoją per kelis IP). |
| `.env` su realiais raktais | Perkelkite raktus į tikrą paslapčių valdymo įrankį (AWS Secrets Manager, HashiCorp Vault, Doppler ir pan.), ne paprastą `.env` failą serveryje. |

### 2 prioritetas - svarbu patikimumui/kainoms

| Rizika | Veiksmas |
|---|---|
| `utils/jobStore.js` tik atmintyje | Migruokite į Redis (paprasčiausia) arba BullMQ/SQS (jei reikia retry/DLQ). Sąsaja (`create/get/update`) suprojektuota taip, kad pakeitimas nereikalautų keisti `routes/jobs.js`. |
| `utils/auditLog.js` tik atmintyje | Migruokite į Postgres/SQLite lentelę. Pridėkite retention politiką (pvz. automatinis senų įrašų trynimas po N dienų) ir apsvarstykite, ar audit įrašuose yra PII (transkripcijos fragmentai promptuose - NE, nes auditLog saugo tik metaduomenis, ne patį tekstą - patikrinkite tai lieka tiesa, jei keisite kodą). |
| Tier 2/3 tiekėjai (Azure/Google/GPT/Gemini/pyannote-cloud/AssemblyAI) niekada netestuoti su realiu raktu | PRIEŠ įjungdami bet kurį iš jų production'e, paleiskite juos su testiniais duomenimis ir realiu raktu STAGING aplinkoje. Nesitikėkite, kad jie veiks be pakeitimų. |
| Visas audio failas skaitomas į RAM | (Iš dalies pataisyta: `/api/transcribe-jobs` async kelias naudoja `fileStorage.putFile` - failas kopijuojamas per diską, ne per RAM.) Sinchroninis `/api/transcribe` kelias vis dar skaito į RAM - dideliems failams naudokite async job endpointą. |
| **Readiness worker heartbeat** (`/api/ready`) | ✅ ĮGYVENDINTA: worker'is rašo Redis raktą `stenograma:worker:lastSeen` su TTL (kas 10s, TTL 30s), o `/api/ready` BullMQ režime tikrina, ar raktas šviežias (`components.workerAlive`). Jei worker konteineris išjungtas/nulūžęs, ready grąžina 503 net kai Redis veikia. PASTABA: heartbeat srautas per tikrą Redis NETESTUOTAS automatiniuose testuose (reikia Redis); heartbeat modulio logika unit-testuota su mock. Prieš production - patikrinkite realiu Redis (išjunkite worker, patikrinkite, kad /api/ready tampa 503). |
| Leksinis (ne semantinis) grounding check | Jei protokolai naudojami teisiniams/atsiskaitomybės tikslams, pridėkite antrą LLM validacijos žingsnį arba embedding-based similarity prieš pasitikėdami `_grounding.verified` lauku. |

### 3 prioritetas - kokybė/UX, ne saugumas

| Rizika | Veiksmas |
|---|---|
| ~~HTML `.doc`, ne tikras `.docx`~~ (IŠTAISYTA) | Tikras OOXML `.docx` jau implementuotas (`docx` npm paketas). Liko: pridėti įmonės šabloną (logotipas, spalvos, parašų vietos), jei reikia firminio stiliaus. |
| Frontend testai tik `utils.js` | Pridėkite React Testing Library komponento testus (formos pildymas, backend health indikatorius) ir mocked-fetch API srauto testus. |
| PDF eksporto nėra | Pridėkite, jei klientams reikalingas. |

---

## Kaip nuspręsti, kuris scenarijus jums tinka

- Naudojate tik savo kompiuteryje / rodote portfolio interviu metu → **Scenarijus A**, nieko keisti nereikia.
- Komanda iki ~20 žmonių, uždaras tinklas → **Scenarijus B**, ~30 min konfigūracijos.
- Bet kas internete gali užsiregistruoti/naudotis → **Scenarijus C**, tai jau atskiras projektas (savaitės/mėnesio darbo, ne valandos).

Jei nesate tikri - pradėkite nuo B, ir pereikite prie C punktų tik tada, kai tai TIKRAI reikalinga.
