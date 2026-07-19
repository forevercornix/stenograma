# Diegimas į privatų GitHub repo

Git repo jau paruoštas ir pirmas commit'as padarytas (švarus — jokių paslapčių ar
`node_modules`). Liko tik sukurti privatų repo GitHub'e ir push'inti. Šias komandas
paleiskite **savo mašinoje** (su savo GitHub kredencialais).

## 1. Sukurti privatų repo GitHub'e

Pasirinkite vieną būdą:

**A. Per GitHub CLI (`gh`) — greičiausia:**
```bash
gh repo create stenograma --private --source=. --remote=origin --push
```
Tai sukuria privatų repo, prideda `origin` ir iškart push'ina. **Baigta.**

**B. Per naršyklę (jei nenaudojate `gh`):**
1. https://github.com/new → pavadinimas `stenograma`, **Private**, NEkurkite README/
   .gitignore/LICENSE (jie jau yra repo).
2. Tada lokaliai:
```bash
git remote add origin https://github.com/<jūsų-vartotojas>/stenograma.git
git branch -M main
git push -u origin main
```

## 2. Patikrinti, kad paslaptys nepateko

Po push'o GitHub'e patikrinkite, kad **NĖRA**:
- jokio `.env` failo (tik `.env.example` šablonai),
- `node_modules/`, `.venv/`, `dist/` katalogų.

Šie visi yra `.gitignore` ir nebuvo commit'inti — bet greita akies patikra nepakenks.

## 3. (Vėliau) Įjungti CI ir paruoštų image'ų publikavimą

Repo jau turi GitHub Actions workflow'us:
- `.github/workflows/ci.yml` — testai (backend/frontend/pyannote/whisper/E2E). Paleidžiami
  automatiškai po push'o. Patikrinkite Actions tab, kad žalias.
- `.github/workflows/publish-images.yml` — Docker image'ų publikavimas į GHCR. Prieš
  naudojant: repo **Settings > Actions > General > Workflow permissions = "Read and write"**.
  Tada `git tag v1.0.0 && git push --tags` publikuos image'us.

## 4. Pirmi diegimai (privatus etapas)

Po push'o, kiekvienoje testinėje mašinoje:
```bash
git clone https://github.com/<jūsų-vartotojas>/stenograma.git
cd stenograma
./setup.sh          # mock/CPU priklausomybės
make demo           # ĮSITIKINTI, kad veikia: ✔ upload ✔ transkripcija ✔ LLM ✔ protokolas
```

GPU diegimui — `./setup.sh --gpu` + `make quickstart-gpu` (žr. README ir RUNPOD.md).

## 5. Kai bus tvarkinga — perjungti į viešą

Kai keli diegimai praeis sklandžiai:
1. Repo **Settings > General > Danger Zone > Change visibility > Public**.
2. Prieš tai peržiūrėkite:
   - `LICENSE` (jau yra) — ar tinkama vieša licencija.
   - README pozicionavimą (jau sąžiningas: CI verified / manually verified / NOT verified).
   - Ar Git ISTORIJOJE (ne tik dabartiniuose failuose) nėra paslapčių — kadangi repo
     kurtas švariai (`git init` be senos istorijos), tai neturėtų būti problema, bet
     `git log -p | grep -i "api_key\|sk-ant\|hf_"` greita patikra prieš viešinimą verta.

---

**Statusas dabar:** git repo su 1 švariu commit'u, paruoštas push'inti į privatų repo.
176 failų, 0 paslapčių, 0 artefaktų.
