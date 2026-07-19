# Diegimas į GitHub iš Android telefono (Termux)

Paprasčiausias patikimas būdas iš Android — **Termux** (nemokamas terminalas).
Jame veikia tikras `git`, tad procesas beveik toks pat kaip kompiuteryje. Zip'e jau
yra paruošta git istorija (2 commit'ai), tad push'insite iš karto.

⚠️ **Svarbu:** NEdiekite Termux iš Google Play (ten pasenusi, sugedusi versija).
Diekite iš **F-Droid** arba **GitHub** (žr. žemiau).

---

## 1. Įdiegti Termux

- Atidarykite https://f-droid.org telefone → įdiekite F-Droid → jame raskite ir
  įdiekite **Termux**.
- ARBA tiesiai: https://github.com/termux/termux-app/releases → naujausias `.apk`.

## 2. Paruošti Termux (vienkartinis)

Atidarykite Termux ir įklijuokite (laikykite pirštą → Paste):

```bash
pkg update -y && pkg install -y git gh unzip
termux-setup-storage    # leiskite prieigą prie failų, kai paklaus
```

## 3. Įkelti projekto zip į telefoną

- Atsisiųskite `stenograma-project.zip` į telefoną (į Downloads aplanką).
- Termux'e išarchyvuokite:

```bash
cd ~/storage/downloads
unzip stenograma-project.zip -d ~
cd ~/stenograma-project
```

Patikrinkite, kad git istorija atsikėlė:
```bash
git log --oneline    # turi rodyti 2 commit'us
```
Jei rodo „not a git repository" — zip išsiarchyvavo be paslėpto `.git` aplanko.
Tada žr. skiltį „Jei .git dingo" apačioje.

## 4. Prisijungti prie GitHub

```bash
gh auth login
```
Rinkitės: **GitHub.com** → **HTTPS** → **Login with a web browser**. Termux parodys
kodą (pvz. `XXXX-XXXX`) ir atidarys naršyklę — įveskite kodą, patvirtinkite.

## 5. Sukurti privatų repo ir push'inti

```bash
gh repo create stenograma --private --source=. --remote=origin --push
```

**Baigta.** Repo sukurtas privatus ir kodas įkeltas. Patikrinti:
```bash
gh repo view --web    # atidaro repo naršyklėje
```

---

## Jei `.git` dingo (zip išsiarchyvavo be istorijos)

Kai kurie Android archyvatoriai praleidžia paslėptus aplankus (`.git`). Tada
sukurkite git iš naujo Termux'e:

```bash
cd ~/stenograma-project
git init
git add -A
git config user.email "jusu@email.lt"
git config user.name "Jūsų Vardas"
git commit -m "Stenograma: Milestone 1"
gh repo create stenograma --private --source=. --remote=origin --push
```

Nesijaudinkite dėl paslapčių — `.gitignore` jau apsaugo (`.env`, `node_modules` ir
kt. nebus įkelti, net jei jie būtų telefone).

---

## Po push'o — pirmi diegimai

Diegti PATĮ projektą (paleisti backend/frontend) telefone **neverta** — tam reikia
kompiuterio ar GPU serverio. Telefonas tinka tik kodui į GitHub įkelti ir po to
peržiūrėti (GitHub mobile app).

Realų diegimą darysite kompiuteryje ar RunPod'e:
```bash
git clone https://github.com/<jūsų-vardas>/stenograma.git
cd stenograma
./setup.sh && make demo    # ✔ upload ✔ transkripcija ✔ LLM ✔ protokolas
```

---

## Alternatyva be Termux (jei nenorite terminalo)

GitHub naršyklės „upload files" **netiks** — projektas turi 177 failus, o web
upload'as riboja ~100 vienu kartu ir nesukuria git istorijos teisingai. Termux yra
paprasčiausias patikimas būdas iš telefono. Jei turėsite prieigą prie kompiuterio —
ten dar paprasčiau (žr. `GITHUB_SETUP.md`).
