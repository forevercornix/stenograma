#!/usr/bin/env bash
#
# Stenograma: perėjimas prie EUPL-1.2-or-later (nuo v1.3.0)
# Autorių teisių turėtoja: Juliana Vorono-Baranovska
#
# Paleisti IŠ REPOZITORIJOS ŠAKNIES:
#     bash apply-v1.3.0.sh
#
# Failo pavadinimas turi reikšmę: skriptas save išskiria iš untracked failų
# patikros pagal vardą `apply-v1.3.0.sh`. Pervadinus jį, skriptas praneš apie
# save kaip apie neįtrauktą failą.
#
# Skriptas NIEKO nesiunčia į GitHub. Jis tik paruošia failus ir commit'ą.
# Push darote patys, peržiūrėję rezultatą.

set -euo pipefail

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
skip() { printf '  --  %s\n' "$*"; }
die()  { printf '\033[31mKLAIDA:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Patikros -------------------------------------------------------------

[ -d .git ] || die "Paleiskite iš repozitorijos šaknies (nerandu .git katalogo)."
[ -f README.md ] || die "Nerandu README.md — ar tikrai esate Stenograma šaknyje?"
command -v git >/dev/null || die "Nerandu git."

# ŠVARAUS WORKTREE REIKALAVIMAS, ĮSKAITANT UNTRACKED FAILUS.
#
# Šis skriptas stage'ina TIK savo paties valdomus failus (jokio `git add -A`),
# bet net ir tada nešvarus worktree reiškia, kad nežinia, kas bus commit'e
# kartu. Repozitorijoje gali gulėti `.env`, laikinas audio, eksportuotas
# protokolas ar HF tokenas — nė vienas iš jų neturi patekti į viešą repo.

# FAILAI, KURIUOS ŠIS SKRIPTAS VALDO IR KOMITUOJA.
#
# Vienas sąrašas dviem tikslams: (1) patikrinti, ar kuris nors iš jų jau nėra
# untracked (tada jį sukomituotume nepaisant pažado to nedaryti), (2) stage'inti
# commit'o metu. Sąrašai negali išsiskirti, nes tai ir yra ta skylė.

MANAGED_FILES="LICENSE
LICENSE-MIT
LICENSE-HISTORY.md
LICENSE-COMMERCIAL.md
CONTRIBUTING.md
AUTHORSHIP.md
CHANGELOG.md
README.md
RUNPOD.md
SECURITY.md
backend/README.md
backend/package.json
frontend/package.json
backend/package-lock.json
frontend/package-lock.json
scripts/dev/README.md
.github/pull_request_template.md"

DIRTY_TRACKED="$(git status --porcelain --untracked-files=no)"
DIRTY_UNTRACKED="$(git ls-files --others --exclude-standard | grep -v '^apply-v1\.3\.0\.sh$' || true)"

if [ -n "$DIRTY_TRACKED" ]; then
  say "Nekomituotų pakeitimų sekamuose failuose:"
  printf '%s\n' "$DIRTY_TRACKED"
  printf '\n'
  die "Sukomituokite arba atstatykite juos ir paleiskite iš naujo."
fi

if [ -n "$DIRTY_UNTRACKED" ]; then
  # SVARBIAUSIA PATIKRA: jei untracked failas yra skripto valdomų sąraše,
  # gale jį sukomituotume - nepaisant to, ką ką tik pažadėjome vartotojui.
  # Tokiu atveju ALLOW_UNTRACKED nepadeda: reikia žmogaus sprendimo.
  COLLIDING="$(printf '%s\n' "$DIRTY_UNTRACKED" \
    | grep -Fxf <(printf '%s\n' "$MANAGED_FILES") || true)"

  if [ -n "$COLLIDING" ]; then
    say "SUSTABDYTA: šie untracked failai yra skripto valdomų sąraše:"
    printf '%s\n' "$COLLIDING"
    printf '\n'
    printf 'Jie būtų sukomituoti kaip v1.3.0 dalis, nors skriptas ir žada\n'
    printf 'untracked failų neliesti. Peržiūrėkite jų turinį ir arba\n'
    printf 'sukomituokite atskirai, arba pašalinkite, ir paleiskite iš naujo.\n'
    printf 'ALLOW_UNTRACKED šio atvejo NEAPEINA - tai sąmoninga.\n\n'
    die "Nutraukta."
  fi

  say "Repozitorijoje yra neįtrauktų (untracked) failų:"
  printf '%s\n' "$DIRTY_UNTRACKED"
  printf '\n'
  printf 'Skriptas jų NEKOMITUOS, bet prieš viešą release verta įsitikinti,\n'
  printf 'kad tarp jų nėra paslapčių (.env, tokenai, audio įrašai).\n'
  printf 'Peržiūrėję galite tęsti nustatę ALLOW_UNTRACKED=1.\n\n'
  if [ "${ALLOW_UNTRACKED:-0}" != "1" ]; then
    die "Nutraukta. Peržiūrėkite failus arba paleiskite: ALLOW_UNTRACKED=1 bash apply-v1.3.0.sh"
  fi
  say "ALLOW_UNTRACKED=1 — tęsiama, untracked failai nebus komituojami."
fi

say "1/8  Licencijos failai"

# EUPL-1.2 tekstas žemiau paimtas iš SPDX license-list-data
# (raw.githubusercontent.com/spdx/license-list-data, failas text/EUPL-1.2.txt) —
# vetted, mašininiu būdu tikrinamas canonical tekstas, be OCR ar rankinio
# performatavimo. Oficialūs Komisijos vertimai: joinup.ec.europa.eu.
#
# Šaltinio teksto SHA-256 (be žemiau pridėtos autorių teisių antraštės):
#   57fb42fbcd0b037ce528ed8f72f1ec095d67bc6825ecf1448ff39be1fe68a4b4
# Pasitikrinti galima taip:
#   curl -s https://raw.githubusercontent.com/spdx/license-list-data/main/text/EUPL-1.2.txt | sha256sum

# --- LICENSE --------------------------------------------------------------

cat > LICENSE <<'EOF_LICENSE'
Copyright (c) 2026 Juliana Vorono-Baranovska

Licensed under the EUPL

Licensed under the European Union Public Licence (EUPL), Version 1.2 or -
as soon as they will be approved by the European Commission - subsequent
versions of the EUPL (the "Licence").

You may not use this work except in compliance with the Licence.
You may obtain a copy of the Licence, including official translations into
all official languages of the European Union, at:

    https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12

Unless required by applicable law or agreed to in writing, software
distributed under the Licence is distributed on an "AS IS" basis, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
Licence for the specific language governing permissions and limitations
under the Licence.

NOTE ON EARLIER VERSIONS: versions of this Work up to and including v1.2.0
were distributed under the MIT Licence. That licence remains valid for
those versions and is not revoked. See LICENSE-HISTORY.md.

--------------------------------------------------------------------------

EUROPEAN UNION PUBLIC LICENCE v. 1.2
EUPL © the European Union 2007, 2016

This European Union Public Licence (the ‘EUPL’) applies to the Work (as defined below) which is provided under the
terms of this Licence. Any use of the Work, other than as authorised under this Licence is prohibited (to the extent such
use is covered by a right of the copyright holder of the Work).
The Work is provided under the terms of this Licence when the Licensor (as defined below) has placed the following
notice immediately following the copyright notice for the Work:
                          Licensed under the EUPL
or has expressed by any other means his willingness to license under the EUPL.

1.Definitions
In this Licence, the following terms have the following meaning:
— ‘The Licence’:this Licence.
— ‘The Original Work’:the work or software distributed or communicated by the Licensor under this Licence, available
as Source Code and also as Executable Code as the case may be.
— ‘Derivative Works’:the works or software that could be created by the Licensee, based upon the Original Work or
modifications thereof. This Licence does not define the extent of modification or dependence on the Original Work
required in order to classify a work as a Derivative Work; this extent is determined by copyright law applicable in
the country mentioned in Article 15.
— ‘The Work’:the Original Work or its Derivative Works.
— ‘The Source Code’:the human-readable form of the Work which is the most convenient for people to study and
modify.
— ‘The Executable Code’:any code which has generally been compiled and which is meant to be interpreted by
a computer as a program.
— ‘The Licensor’:the natural or legal person that distributes or communicates the Work under the Licence.
— ‘Contributor(s)’:any natural or legal person who modifies the Work under the Licence, or otherwise contributes to
the creation of a Derivative Work.
— ‘The Licensee’ or ‘You’:any natural or legal person who makes any usage of the Work under the terms of the
Licence.
— ‘Distribution’ or ‘Communication’:any act of selling, giving, lending, renting, distributing, communicating,
transmitting, or otherwise making available, online or offline, copies of the Work or providing access to its essential
functionalities at the disposal of any other natural or legal person.

2.Scope of the rights granted by the Licence
The Licensor hereby grants You a worldwide, royalty-free, non-exclusive, sublicensable licence to do the following, for
the duration of copyright vested in the Original Work:
— use the Work in any circumstance and for all usage,
— reproduce the Work,
— modify the Work, and make Derivative Works based upon the Work,
— communicate to the public, including the right to make available or display the Work or copies thereof to the public
and perform publicly, as the case may be, the Work,
— distribute the Work or copies thereof,
— lend and rent the Work or copies thereof,
— sublicense rights in the Work or copies thereof.
Those rights can be exercised on any media, supports and formats, whether now known or later invented, as far as the
applicable law permits so.
In the countries where moral rights apply, the Licensor waives his right to exercise his moral right to the extent allowed
by law in order to make effective the licence of the economic rights here above listed.
The Licensor grants to the Licensee royalty-free, non-exclusive usage rights to any patents held by the Licensor, to the
extent necessary to make use of the rights granted on the Work under this Licence.

3.Communication of the Source Code
The Licensor may provide the Work either in its Source Code form, or as Executable Code. If the Work is provided as
Executable Code, the Licensor provides in addition a machine-readable copy of the Source Code of the Work along with
each copy of the Work that the Licensor distributes or indicates, in a notice following the copyright notice attached to
the Work, a repository where the Source Code is easily and freely accessible for as long as the Licensor continues to
distribute or communicate the Work.

4.Limitations on copyright
Nothing in this Licence is intended to deprive the Licensee of the benefits from any exception or limitation to the
exclusive rights of the rights owners in the Work, of the exhaustion of those rights or of other applicable limitations
thereto.

5.Obligations of the Licensee
The grant of the rights mentioned above is subject to some restrictions and obligations imposed on the Licensee. Those
obligations are the following:

Attribution right: The Licensee shall keep intact all copyright, patent or trademarks notices and all notices that refer to
the Licence and to the disclaimer of warranties. The Licensee must include a copy of such notices and a copy of the
Licence with every copy of the Work he/she distributes or communicates. The Licensee must cause any Derivative Work
to carry prominent notices stating that the Work has been modified and the date of modification.

Copyleft clause: If the Licensee distributes or communicates copies of the Original Works or Derivative Works, this
Distribution or Communication will be done under the terms of this Licence or of a later version of this Licence unless
the Original Work is expressly distributed only under this version of the Licence — for example by communicating
‘EUPL v. 1.2 only’. The Licensee (becoming Licensor) cannot offer or impose any additional terms or conditions on the
Work or Derivative Work that alter or restrict the terms of the Licence.

Compatibility clause: If the Licensee Distributes or Communicates Derivative Works or copies thereof based upon both
the Work and another work licensed under a Compatible Licence, this Distribution or Communication can be done
under the terms of this Compatible Licence. For the sake of this clause, ‘Compatible Licence’ refers to the licences listed
in the appendix attached to this Licence. Should the Licensee's obligations under the Compatible Licence conflict with
his/her obligations under this Licence, the obligations of the Compatible Licence shall prevail.

Provision of Source Code: When distributing or communicating copies of the Work, the Licensee will provide
a machine-readable copy of the Source Code or indicate a repository where this Source will be easily and freely available
for as long as the Licensee continues to distribute or communicate the Work.
Legal Protection: This Licence does not grant permission to use the trade names, trademarks, service marks, or names
of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and
reproducing the content of the copyright notice.

6.Chain of Authorship
The original Licensor warrants that the copyright in the Original Work granted hereunder is owned by him/her or
licensed to him/her and that he/she has the power and authority to grant the Licence.
Each Contributor warrants that the copyright in the modifications he/she brings to the Work are owned by him/her or
licensed to him/her and that he/she has the power and authority to grant the Licence.
Each time You accept the Licence, the original Licensor and subsequent Contributors grant You a licence to their contributions
to the Work, under the terms of this Licence.

7.Disclaimer of Warranty
The Work is a work in progress, which is continuously improved by numerous Contributors. It is not a finished work
and may therefore contain defects or ‘bugs’ inherent to this type of development.
For the above reason, the Work is provided under the Licence on an ‘as is’ basis and without warranties of any kind
concerning the Work, including without limitation merchantability, fitness for a particular purpose, absence of defects or
errors, accuracy, non-infringement of intellectual property rights other than copyright as stated in Article 6 of this
Licence.
This disclaimer of warranty is an essential part of the Licence and a condition for the grant of any rights to the Work.

8.Disclaimer of Liability
Except in the cases of wilful misconduct or damages directly caused to natural persons, the Licensor will in no event be
liable for any direct or indirect, material or moral, damages of any kind, arising out of the Licence or of the use of the
Work, including without limitation, damages for loss of goodwill, work stoppage, computer failure or malfunction, loss
of data or any commercial damage, even if the Licensor has been advised of the possibility of such damage. However,
the Licensor will be liable under statutory product liability laws as far such laws apply to the Work.

9.Additional agreements
While distributing the Work, You may choose to conclude an additional agreement, defining obligations or services
consistent with this Licence. However, if accepting obligations, You may act only on your own behalf and on your sole
responsibility, not on behalf of the original Licensor or any other Contributor, and only if You agree to indemnify,
defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against such Contributor by
the fact You have accepted any warranty or additional liability.

10.Acceptance of the Licence
The provisions of this Licence can be accepted by clicking on an icon ‘I agree’ placed under the bottom of a window
displaying the text of this Licence or by affirming consent in any other similar way, in accordance with the rules of
applicable law. Clicking on that icon indicates your clear and irrevocable acceptance of this Licence and all of its terms
and conditions.
Similarly, you irrevocably accept this Licence and all of its terms and conditions by exercising any rights granted to You
by Article 2 of this Licence, such as the use of the Work, the creation by You of a Derivative Work or the Distribution
or Communication by You of the Work or copies thereof.

11.Information to the public
In case of any Distribution or Communication of the Work by means of electronic communication by You (for example,
by offering to download the Work from a remote location) the distribution channel or media (for example, a website)
must at least provide to the public the information requested by the applicable law regarding the Licensor, the Licence
and the way it may be accessible, concluded, stored and reproduced by the Licensee.

12.Termination of the Licence
The Licence and the rights granted hereunder will terminate automatically upon any breach by the Licensee of the terms
of the Licence.
Such a termination will not terminate the licences of any person who has received the Work from the Licensee under
the Licence, provided such persons remain in full compliance with the Licence.

13.Miscellaneous
Without prejudice of Article 9 above, the Licence represents the complete agreement between the Parties as to the
Work.
If any provision of the Licence is invalid or unenforceable under applicable law, this will not affect the validity or
enforceability of the Licence as a whole. Such provision will be construed or reformed so as necessary to make it valid
and enforceable.
The European Commission may publish other linguistic versions or new versions of this Licence or updated versions of
the Appendix, so far this is required and reasonable, without reducing the scope of the rights granted by the Licence.
New versions of the Licence will be published with a unique version number.
All linguistic versions of this Licence, approved by the European Commission, have identical value. Parties can take
advantage of the linguistic version of their choice.

14.Jurisdiction
Without prejudice to specific agreement between parties,
— any litigation resulting from the interpretation of this License, arising between the European Union institutions,
bodies, offices or agencies, as a Licensor, and any Licensee, will be subject to the jurisdiction of the Court of Justice
of the European Union, as laid down in article 272 of the Treaty on the Functioning of the European Union,
— any litigation arising between other parties and resulting from the interpretation of this License, will be subject to
the exclusive jurisdiction of the competent court where the Licensor resides or conducts its primary business.

15.Applicable Law
Without prejudice to specific agreement between parties,
— this Licence shall be governed by the law of the European Union Member State where the Licensor has his seat,
resides or has his registered office,
— this licence shall be governed by Belgian law if the Licensor has no seat, residence or registered office inside
a European Union Member State.


                                                         Appendix

‘Compatible Licences’ according to Article 5 EUPL are:
— GNU General Public License (GPL) v. 2, v. 3
— GNU Affero General Public License (AGPL) v. 3
— Open Software License (OSL) v. 2.1, v. 3.0
— Eclipse Public License (EPL) v. 1.0
— CeCILL v. 2.0, v. 2.1
— Mozilla Public Licence (MPL) v. 2
— GNU Lesser General Public Licence (LGPL) v. 2.1, v. 3
— Creative Commons Attribution-ShareAlike v. 3.0 Unported (CC BY-SA 3.0) for works other than software
— European Union Public Licence (EUPL) v. 1.1, v. 1.2
— Québec Free and Open-Source Licence — Reciprocity (LiLiQ-R) or Strong Reciprocity (LiLiQ-R+).

The European Commission may update this Appendix to later versions of the above licences without producing
a new version of the EUPL, as long as they provide the rights granted in Article 2 of this Licence and protect the
covered Source Code from exclusive appropriation.
All other changes or additions to this Appendix require the production of a new EUPL version.
EOF_LICENSE
ok "LICENSE (EUPL-1.2-or-later)"

# --- LICENSE-MIT (archyvas) ----------------------------------------------

cat > LICENSE-MIT <<'EOF_MIT'
ARCHYVINIS FAILAS / ARCHIVED FILE
=================================
Ši MIT licencija galiojo Stenograma versijoms iki v1.2.0 imtinai ir toms
versijoms lieka galioti. Nuo v1.3.0 taikoma EUPL-1.2-or-later (žr. LICENSE).

This MIT Licence applied to Stenograma versions up to and including v1.2.0
and remains in force for those versions. From v1.3.0 onward, EUPL-1.2-or-later
applies (see LICENSE).

Autorių teisių turėtoja / Copyright holder: Juliana Vorono-Baranovska.
Žemiau pateiktas tekstas išsaugotas tokia forma, kokia buvo platinamas.
The text below is preserved as originally distributed.

---------------------------------------------------------------------------

MIT License

Copyright (c) 2026 Stenograma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF_MIT
ok "LICENSE-MIT (archyvinis MIT tekstas)"

# --- LICENSE-HISTORY.md ---------------------------------------------------

cat > LICENSE-HISTORY.md <<'EOF_HISTORY'
# Licencijos istorija

Šis dokumentas paaiškina, kokia licencija galioja kuriai Stenograma versijai.
Jis egzistuoja tam, kad perėjimas prie kitos licencijos būtų skaidrus, o ne
tylus.

## Santrauka

| Versijos | Licencija |
|---|---|
| iki `v1.2.0` imtinai (įskaitant visus tų versijų commit'us) | MIT |
| nuo `v1.3.0` | EUPL-1.2-or-later (SPDX: `EUPL-1.2`) |

## Ką tai reiškia praktiškai

**MIT licencija ankstesnėms versijoms lieka galioti ir nėra atšaukiama.**
Kiekvienas, kas gavo Stenograma kodą pagal MIT licenciją, išsaugo visas tos
licencijos suteiktas teises toms versijoms — neterminuotai. Licencijos
pakeitimas galioja tik naujam kodui, išleistam nuo `v1.3.0`.

Autorius neteigia ir netvirtina, kad ankstesnės MIT licencijos galiojimas
kaip nors apribotas.

MIT licencijos tekstas, galiojęs iki `v1.2.0` imtinai, išsaugotas faile
[`LICENSE-MIT`](LICENSE-MIT).

## Kodėl pakeista

Stenograma toliau vystoma pagal **dvigubos licencijos (dual-licensing)**
modelį — tas pats kodas prieinamas pagal atvirąją licenciją, o alternatyviai
galima gauti komercinę. Tai NĖRA open core: uždarų, tik mokamų funkcijų nėra,
ir visas kodas lieka atviras.

- kodas lieka atviras ir laisvai prieinamas pagal EUPL-1.2-or-later
  (SPDX license identifier: `EUPL-1.2`);
- EUPL yra Europos Komisijos parengta, OSI patvirtinta licencija su
  oficialiais vertimais į visas ES kalbas, įskaitant lietuvių — tai
  supaprastina naudojimą viešojo sektoriaus ir švietimo įstaigose;
- EUPL yra reciprokinė (copyleft): platinant modifikuotą versiją, pakeitimai
  turi būti prieinami ta pačia licencija.

Organizacijoms, kurioms EUPL reciprokiškumas netinka, galima atskira
komercinė licencija — žr. [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md).

## Autorių teisių turėtojas

Juliana Vorono-Baranovska (fizinis asmuo).

Prekės ženklas, pavadinimas „Stenograma" ir logotipas licencija neperduodami —
EUPL suteikia teises į kodą, ne į pavadinimą.
EOF_HISTORY
ok "LICENSE-HISTORY.md"

# --- LICENSE-COMMERCIAL.md ------------------------------------------------

cat > LICENSE-COMMERCIAL.md <<'EOF_COMM'
# Komercinė licencija

Stenograma platinama pagal **dvigubos licencijos** modelį: atvirojo kodo
**EUPL-1.2-or-later** (SPDX license identifier: `EUPL-1.2`) arba atskira
komercinė licencija.

## Kada pakanka EUPL-1.2-or-later (nemokamai)

Numatytoji licencija ([`LICENSE`](LICENSE)) tinka daugumai atvejų, įskaitant
komercinį naudojimą savo reikmėms:

- diegimas savo organizacijoje (mokykla, savivaldybė, įmonė, NVO);
- modifikavimas savo poreikiams;
- naudojimas paslaugoms savo organizacijos viduje teikti.

EUPL yra reciprokinė licencija. Jei **platinate** Stenograma ar jos
modifikuotą (derivative) versiją arba suteikiate tretiesiems asmenims prieigą
prie jos funkcijų nuotoliniu būdu, EUPL 5 str. pareigos taikomos **tam
kūriniui**: gavėjams turi būti prieinamas jo pirminis kodas ta pačia licencija.

Ši pareiga apima Stenograma ir jos modifikacijas, o ne automatiškai visą jūsų
programinę įrangą — kur baigiasi derivative work, sprendžia taikytina autorių
teisė, ne pati licencija. Jei riba jūsų atveju neaiški, tai kaip tik ir yra
priežastis pasikalbėti dėl komercinės licencijos.

## Kada verta arba gali reikėti komercinės licencijos

Atskira licencija aktuali, jei norite:

- integruoti Stenograma ar jos modifikuotą versiją į uždarą (nuosavybinį)
  produktą, kai tokiai integracijai būtų taikomos EUPL reciprokiškumo pareigos;
- platinti modifikuotą versiją **neatskleisdami** jai padarytų pakeitimų;
- teikti Stenograma (ar jos modifikuotos versijos) pagrindu veikiančią SaaS
  paslaugą neatverdami tam kūriniui padarytų pakeitimų;
- gauti garantijas, atsakomybės prisiėmimą, SLA arba palaikymą, kurių EUPL
  aiškiai neteikia (EUPL 7–8 str. — „AS IS").

## Sąlygos

Komercinė licencija derinama individualiai. Standartiškai apibrėžiama:

| Elementas | Pastaba |
|---|---|
| Suteikiamos teisės | naudojimas, modifikavimas, platinimas be reciprokiškumo |
| Išimtinumas | neišimtinė (numatyta) |
| Teritorija | pasaulis arba ES |
| Terminas | terminuota (pvz. metinė) arba neterminuota |
| Atlyginimas | vienkartinis arba periodinis |
| Palaikymas | derinamas atskirai, nėra įtrauktas automatiškai |

## Kontaktai

Licenciarė: **Juliana Vorono-Baranovska**.

Užklausoms dėl komercinės licencijos: **juliana.vorono@gmail.com**

## Svarbu

- Licencija suteikiama **kodui**. Pavadinimas „Stenograma" ir su juo susiję
  žymenys licencija neperduodami.
- Stenograma versijos **iki `v1.2.0` imtinai** buvo išleistos pagal MIT
  licenciją ir toms versijoms ji lieka galioti (žr.
  [`LICENSE-HISTORY.md`](LICENSE-HISTORY.md)). Komercinė licencija aktuali
  `v1.3.0` ir vėlesnėms versijoms.
- Sistema naudoja trečiųjų šalių komponentus (faster-whisper, pyannote.audio,
  Node/Python bibliotekas) su savo licencijomis. Kai kurie modeliai (pvz.
  pyannote „gated" modeliai) reikalauja atskirai priimti tiekėjo sąlygas.
  Komercinė Stenograma licencija šių įsipareigojimų nepakeičia.
EOF_COMM
ok "LICENSE-COMMERCIAL.md"

# --- package.json ---------------------------------------------------------

say "2/8  package.json licencijos laukai"

# SVARBU: tikrinama license lauko REIKŠMĖ, ne tik buvimas. Jei ten liktų
# "MIT", package metadata prieštarautų LICENSE failui, README ir release
# aprašymui — tyliai ir sunkiai pastebimai.

for pkg in backend/package.json frontend/package.json; do
  if [ ! -f "$pkg" ]; then
    skip "$pkg nerastas — praleista"
  elif grep -q '"license": "EUPL-1.2"' "$pkg"; then
    skip "$pkg jau EUPL-1.2 (SPDX id; politika - EUPL-1.2-or-later)"
  elif grep -q '"license":' "$pkg"; then
    # Yra kitokia reikšmė (pvz. MIT) — keičiame ją, o ne praleidžiame.
    OLD_LIC="$(grep -o '"license": "[^"]*"' "$pkg" | head -1)"
    awk '{ sub(/"license": "[^"]*"/, "\"license\": \"EUPL-1.2\""); print }' \
      "$pkg" > "$pkg.tmp" && mv "$pkg.tmp" "$pkg"
    grep -q '"license": "EUPL-1.2"' "$pkg" \
      || die "$pkg: nepavyko pakeisti $OLD_LIC į SPDX id EUPL-1.2."
    ok "$pkg ($OLD_LIC -> EUPL-1.2 — SPDX id; politika EUPL-1.2-or-later)"
  else
    sed -i '0,/"version":/s//"license": "EUPL-1.2",\n  "author": "Juliana Vorono-Baranovska",\n  "version":/' "$pkg"
    grep -q '"license": "EUPL-1.2"' "$pkg" \
      || die "$pkg: nepavyko pridėti license lauko. Pridėkite ranka ir paleiskite iš naujo."
    ok "$pkg"
  fi
done

# --- README.md ------------------------------------------------------------

say "3/8  README.md licencijos skyrius"

OLD_LINE='MIT — žr. [`LICENSE`](LICENSE).'

if grep -qF 'Stenograma platinama pagal **EUPL-1.2 arba' README.md; then
  skip "README jau atnaujintas"
elif grep -qF "$OLD_LINE" README.md; then
  cat > .license-section.tmp <<'EOF_SECTION'
Stenograma platinama pagal **EUPL-1.2 arba, gavėjo pasirinkimu, bet kurią
vėlesnę Europos Komisijos patvirtintą EUPL versiją** (EUPL-1.2-or-later) —
tai Komisijos parengta, OSI patvirtinta atvirojo kodo licencija su oficialiu
lietuvišku vertimu. SPDX identifikatorius: `EUPL-1.2`. Žr. [`LICENSE`](LICENSE).

Copyright (c) 2026 Juliana Vorono-Baranovska

**Versijos iki `v1.2.0` imtinai buvo išleistos pagal MIT licenciją ir toms
versijoms ji lieka galioti** — žr. [`LICENSE-HISTORY.md`](LICENSE-HISTORY.md).
MIT tekstas išsaugotas faile [`LICENSE-MIT`](LICENSE-MIT).

Organizacijoms, kurioms EUPL reciprokiškumo pareigos netinka (Stenograma ar
jos modifikuotos versijos integravimas į uždarą produktą arba teikimas
klientams neatskleidžiant pakeitimų), galima atskira komercinė licencija —
žr. [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md).

Kas projektą sukūrė ir kaip (įskaitant AI įrankių naudojimą bei commit'ų
tapatybių paaiškinimą) — [`AUTHORSHIP.md`](AUTHORSHIP.md).
EOF_SECTION
  awk -v target="$OLD_LINE" -v secfile=".license-section.tmp" '
    $0 == target { while ((getline line < secfile) > 0) print line; next }
    { print }
  ' README.md > README.md.new && mv README.md.new README.md
  rm -f .license-section.tmp
  grep -qF 'Stenograma platinama pagal **EUPL-1.2 arba' README.md \
    || die "KRITINIS: README licencijos skyriaus pakeisti nepavyko. Release nutrauktas."
  ok "README.md licencijos skyrius pakeistas"
else
  die "KRITINIS: README nerastas nei senas MIT licencijos skyrius, nei naujas EUPL skyrius. Patikrinkite rankiniu būdu."
fi


# =========================================================================
# 4/8  Versijų sinchronizacija 1.2.0 -> 1.3.0
# =========================================================================

say "4/8  Versijos numeris"

for pkg in backend/package.json frontend/package.json \
           backend/package-lock.json frontend/package-lock.json; do
  if [ ! -f "$pkg" ]; then
    skip "$pkg nerastas"
  elif head -5 "$pkg" | grep -q '"version": "1.3.0"'; then
    skip "$pkg jau 1.3.0"
  else
    awk 'NR<=12 { sub(/"version": "1\.2\.0"/, "\"version\": \"1.3.0\"") } { print }' \
      "$pkg" > "$pkg.tmp" && mv "$pkg.tmp" "$pkg"
    head -12 "$pkg" | grep -q '"version": "1.3.0"' \
      || die "KRITINIS: $pkg versijos pakeisti nepavyko."
    ok "$pkg"
  fi
done

if grep -qF '`v1.3.0` (ne production-ready)' README.md; then
  skip "README status eilutė jau 1.3.0"
elif grep -qF '`v1.2.0` (ne production-ready)' README.md; then
  sed -i 's/`v1\.2\.0` (ne production-ready)/`v1.3.0` (ne production-ready)/' README.md
  grep -qF '`v1.3.0` (ne production-ready)' README.md \
    || die "KRITINIS: nepavyko atnaujinti README versijos eilutės."
  ok "README status eilutė"
else
  die "KRITINIS: README status eilutė nerasta nei su v1.2.0, nei su v1.3.0. Patikrinkite rankiniu būdu."
fi

# =========================================================================
# 5/8  Faktinių skaičių tikslinimas
# =========================================================================
#
# Projekto stiprybė - kad dokumentacija atitinka realybę. Šie skaičiai
# atsiliko: patikrinta paleidus testus (backend 1042, frontend 64).

say "5/8  Testų skaičiai dokumentacijoje"

fix() { # failas, senas, naujas, aprašymas
  local f="$1" old="$2" new="$3" desc="$4"
  if [ ! -f "$f" ]; then skip "$f nerastas"; return; fi
  if grep -qF -- "$new" "$f"; then skip "$desc — jau atnaujinta"; return; fi
  if ! grep -qF -- "$old" "$f"; then skip "$desc — nerasta (jau pakeista?)"; return; fi
  awk -v old="$old" -v new="$new" '
    {
      i = index($0, old)
      if (i > 0) $0 = substr($0, 1, i-1) new substr($0, i + length(old))
      print
    }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  if grep -qF -- "$new" "$f"; then ok "$desc"; else skip "$desc — nepavyko, pakeiskite ranka"; fi
}

# Kritiniams pakeitimams (versija, licencija, package metadata) klaida NEGALI
# baigtis „pakeiskite ranka" ir vis tiek sukurtu tag'u. Tam - must_fix().
must_fix() { # failas, senas, naujas, aprašymas
  local f="$1" old="$2" new="$3" desc="$4"
  if grep -qF -- "$new" "$f" 2>/dev/null; then skip "$desc — jau atnaujinta"; return; fi
  fix "$f" "$old" "$new" "$desc"
  grep -qF -- "$new" "$f" 2>/dev/null \
    || die "KRITINIS: $desc nepavyko. Release nutrauktas, commit'as nesukurtas."
}

fix README.md \
  "| Backend (Node/API) | Testuota | 558 testai" \
  "| Backend (Node/API) | Testuota | 1042 testai" \
  "README: backend testų skaičius (lentelė)"

fix README.md \
  "npm test        # 558 testai" \
  "npm test        # 1042 testai" \
  "README: npm test komentaras"

fix README.md \
  "Supertest (558 testai, plius 11 integracinių su tikru Redis)" \
  "Supertest (1042 testai, plius 3 integraciniai su tikru Redis)" \
  "README: technologijų skyrius"

fix README.md \
  "- frontend: 24 Vitest testai + \`vite build\`" \
  "- frontend: 64 Vitest testai + \`vite build\`" \
  "README: CI verified frontend"

fix README.md \
  "Vitest (24 testų: 19 grynoms \`src/utils.js\` funkcijoms + 5 komponento/integracijos" \
  "Vitest (64 testai: 19 \`src/utils.js\`, 19 \`src/api/stenogramaApi.js\`, 26 komponento/integracijos" \
  "README: frontend testų sudėtis"

fix backend/README.md \
  "npm test        # node --test (built-in) - 107 testų" \
  "npm test        # node --test (built-in) - 1042 testai" \
  "backend/README: testų skaičius"

# --- Node versija: CHANGELOG teigia 20->22 „visose vietose", bet ne visur ---

fix README.md \
  "| **Node.js** | 20 | 20 LTS | Backend + frontend |" \
  "| **Node.js** | 22 | 22 LTS | Backend + frontend |" \
  "README: Node.js reikalavimų lentelė"

fix README.md \
  "**Backend:** Node.js 20+, Express" \
  "**Backend:** Node.js 22+, Express" \
  "README: Node.js technologijų skyriuje"

fix RUNPOD.md \
  "**Node.js 20+ NĖRA iš anksto įdiegtas.**" \
  "**Node.js 22+ NĖRA iš anksto įdiegtas.**" \
  "RUNPOD.md: Node.js versija"

# =========================================================================
# 6/8  Įnašų licencijavimas ir autorystė
#
# Dvigubai licencijai reikia turėti pakankamas relicencijavimo teises į
# įnašus. CONTRIBUTING.md + PR šablono varnelė yra vienas iš būdų tai
# užtikrinti - paprastas ir pakankamas, kol įnašai reti.
# =========================================================================

say "6/8  CONTRIBUTING.md ir AUTHORSHIP.md"

if [ -f CONTRIBUTING.md ]; then
  grep -qF '## Įnašų licencijavimo sąlygos' CONTRIBUTING.md \
    || die "CONTRIBUTING.md yra, bet neatitinka v1.3.0 turinio (nerastas įnašų licencijavimo skyrius). Peržiūrėkite arba pašalinkite jį ir paleiskite iš naujo."
  skip "CONTRIBUTING.md jau atitinka v1.3.0"
else
  cat > CONTRIBUTING.md <<'EOF_CONTRIB'
# Prisidėjimas prie Stenograma

Ačiū už susidomėjimą. Prieš siunčiant pull request'ą, vieną dalyką būtina
perskaityti — jis netipinis ir svarbus.

## Įnašų licencijavimo sąlygos (svarbu)

Stenograma platinama pagal **dvigubą licenciją**: atvirojo kodo
**EUPL-1.2-or-later** (SPDX license identifier: `EUPL-1.2`) ir atskira
komercinė licencija (žr. [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md)).

Kad projekto prižiūrėtoja galėtų toliau išduoti komercines licencijas, ji turi
turėti pakankamas relicencijavimo teises į **visą** projekto kodą. Todėl, siųsdami pull
request'ą ir patvirtindami tai PR šablono varnele, jūs:

1. patvirtinate, kad kodas yra jūsų sukurtas ir turite teisę jį perduoti;
2. suteikiate projekto prižiūrėtojai neišimtinę, neterminuotą, neatšaukiamą,
   pasaulinę teisę jūsų įnašą naudoti, modifikuoti ir platinti **bet kokia
   licencija**, įskaitant komercinę;
3. patvirtinate, kad jūsų įnašas nepažeidžia trečiųjų šalių teisių.

Jūs išsaugote savo autorystę ir teises į savo kodą — tai nėra teisių atsisakymas,
o leidimas juos naudoti dvigubos licencijos modelyje.

Jei tai jums nepriimtina, prašom nesiųsti PR — bet pranešimai apie klaidas
(issues) visada laukiami ir jokio teisių klausimo nekelia.

**Formalumo lygis.** Šios sąlygos kartu su PR šablono patvirtinimu yra
lengvasvoris įnašų licencijavimo susitarimas, o ne pasirašytas Contributor
License Agreement. Stambesniems įnašams arba prieš komercinį sandorį
prižiūrėtoja gali paprašyti atskiro rašytinio susitarimo.

**Jei naudojote AI įrankius** kodui generuoti, nurodykite tai PR aprašyme.
Tai ne kliūtis — tai skaidrumo reikalavimas, kurio šiame projekte laikomasi
nuosekliai.

## Techniniai reikalavimai

Prieš siunčiant:

```bash
cd backend && npm test && npm run lint
cd ../frontend && npx vitest run && npm run build
```

Šiame projekte galioja taisyklė: **jei pakeitimas liečia dokumentacijoje
nurodytą faktą (skaičių, kintamojo vardą, komandą), dokumentacija keičiama
tame pačiame PR.** Dalis testų tai tikrina automatiškai.

## Klaidų pranešimai

Saugumo spragų **neteikite** per viešus issue — žr. [`SECURITY.md`](SECURITY.md).
EOF_CONTRIB
  ok "CONTRIBUTING.md sukurtas"
fi

# --- SECURITY.md: pridėti realų kontaktą ---

if grep -qF "juliana.vorono@gmail.com" SECURITY.md 2>/dev/null; then
  skip "SECURITY.md kontaktas jau nurodytas"
elif [ -f SECURITY.md ]; then
  SEC_OLD="Otherwise, contact the project maintainer privately."
  SEC_NEW="Otherwise, contact the project maintainer privately at juliana.vorono@gmail.com."
  if grep -qF "$SEC_OLD" SECURITY.md; then
    awk -v old="$SEC_OLD" -v new="$SEC_NEW" '
      { i = index($0, old); if (i > 0) $0 = substr($0,1,i-1) new substr($0, i+length(old)); print }
    ' SECURITY.md > SECURITY.md.tmp && mv SECURITY.md.tmp SECURITY.md
    ok "SECURITY.md kontaktas pridėtas"
  else
    skip "SECURITY.md — pridėkite kontaktą ranka"
  fi
fi

# --- AUTHORSHIP.md --------------------------------------------------------

if [ -f AUTHORSHIP.md ]; then
  grep -qF '## Commit'"'"'ų tapatybės git istorijoje' AUTHORSHIP.md \
    || die "AUTHORSHIP.md yra, bet neatitinka v1.3.0 turinio. Peržiūrėkite arba pašalinkite jį ir paleiskite iš naujo."
  skip "AUTHORSHIP.md jau atitinka v1.3.0"
else
  cat > AUTHORSHIP.md <<'EOF_AUTHORSHIP'
# Autorystė ir kūrimo procesas

Šis dokumentas atsako į klausimus, kuriuos kitaip tektų užduoti: kas šį projektą
sukūrė, kaip jis buvo kuriamas ir kam priklauso teisės. Jis parašytas todėl, kad
git istorijoje matyti kelios skirtingos commit'ų tapatybės, o kūrimo tempas
akivaizdžiai nėra įprastas rankiniam rašymui. Abu dalykai turi paprastą
paaiškinimą, ir geriau, kad jis būtų pateiktas iš karto.

---

## Autorė

**Juliana Vorono-Baranovska** — projekto idėja, specifikacija, architektūros
sprendimai, kūrimo kryptis, priėmimo ir atmetimo sprendimai, dokumentacijos
struktūra ir turinys.

Ji yra originalių, žmogaus autorystę turinčių Stenograma kūrinio dalių autorių
teisių turėtoja, projekto prižiūrėtoja ir vienintelė šalis, galinti išduoti
komercines licencijas (žr. [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md)).
Išorinių prisidėjusių asmenų projektas neturi, todėl teisių į projekto kodą
niekas kitas neturi.

---

## Kūrimo procesas

Kodas rašytas naudojant **AI įrankius su žmogaus priežiūra**:

| Vaidmuo | Kas atliko |
|---|---|
| Idėja, dalykinė sritis, reikalavimai | Juliana Vorono-Baranovska |
| Architektūros sprendimai ir kompromisai | Juliana Vorono-Baranovska |
| Kodo generavimas | Claude (Anthropic) |
| Kodo peržiūra ir kritika | ChatGPT (OpenAI) |
| Rezultatų priėmimas, atmetimas, kryptis | Juliana Vorono-Baranovska |
| Realūs testai (4 val. lietuviškas įrašas, RunPod GPU) | Juliana Vorono-Baranovska |

Tai nėra „sugeneruota vienu prompt'u". Projekto struktūra — smulkūs PR'ai,
kiekvienas su paaiškinimu, kodėl sprendimas toks; testai, tikrinantys, kad
dokumentacija atitinka kodą; atskiras „ko sistema NEDARO" registras — yra
kuravimo, ne generavimo rezultatas. Ta pati kryptis matoma ir tose vietose,
kur realus testavimas paneigė pradines prielaidas (pvz. `tiny` modelis
lietuvių kalbai; protokolo pilnumo balo klaida) ir kodas buvo taisomas
pagal rezultatą, ne pagal pradinį planą.

### Teisinė padėtis

Pagal kūrimo metu galiojusias Anthropic ir OpenAI paslaugų sąlygas, santykyje
tarp naudotojo ir tiekėjo teisės į modelio išvestį priskiriamos naudotojui, o
tiekėjas perleidžia jam savo galimas teises į ją. Autorei nėra žinoma apie
jokias trečiųjų šalių pretenzijas į šio projekto kodą.

Iš to **neišplaukia** dvi kitos išvados, kurių šis dokumentas neteigia: kad
konkretus AI įrankiais sukurtas kodo fragmentas turi autorių teisių apsaugą, ir
kad panašumo į trečiųjų šalių kodą rizika yra nulinė.

Kartu sąžininga pasakyti tai, kas dar neišspręsta: ES ir Lietuvos autorių teisė
saugo žmogaus intelektinę kūrybą, o riba, ties kuria AI įrankiais sukurtas
kodas tokia laikomas, teismų praktikoje kol kas nenustatyta. Šis dokumentas
nepateikia teisinės išvados — jis pateikia faktus, kurių reikia, kad tokią
išvadą būtų galima pasidaryti.

---

## Commit'ų tapatybės git istorijoje

Kūrimo eigoje buvo naudojamos kelios git tapatybės — dirbant skirtingose
aplinkose (telefonas/Termux, RunPod pod'as, lokali mašina) ir žymint skirtingas
darbo fazes. **Visos jos priklauso tai pačiai autorei.** Išorinių prisidėjusių
asmenų projektas neturi.

| Tapatybė git istorijoje | Ką reiškia |
|---|---|
| `forevercornix <juliana.vorono@gmail.com>` | pagrindinė autorės tapatybė |
| `forevercornix <...@users.noreply.github.com>` | ta pati autorė, commit'ai per GitHub sąsają |
| `A <a@b.local>` | autorė; minimaliai sukonfigūruota aplinka (Termux/RunPod) |
| `Stenograma Dev <dev@stenograma.local>` | autorė; realaus testavimo fazės pataisos |
| `Code Review <review@stenograma.local>` | autorė; peržiūros metu rastų trūkumų taisymai |
| `Stenograma Assistant <assistant@stenograma.local>` | autorė; audito pataisų serija |
| `dependabot[bot]` | automatinis priklausomybių versijų atnaujinimas |

`dependabot[bot]` commit'ai keičia tik priklausomybių versijų numerius
`package.json` ir lock failuose. Tai automatiniai, nekūrybiniai pakeitimai,
autorių teisių klausimo nekeliantys.

Tapatybės **nėra sunorminamos atgaline data** — git istorija netaisoma. Šis
dokumentas yra tinkamesnis būdas paaiškinti, nei `git filter-branch`.

---

## Išoriniai įnašai

Šiuo metu projektas išorinių įnašų neturi. Ateities įnašams taikomos
[`CONTRIBUTING.md`](CONTRIBUTING.md) įnašų licencijavimo sąlygos, kurios
reikalauja suteikti autorei teisę įnašą naudoti bet kokia licencija — tai
leidžia išsaugoti dvigubos licencijos modelį priimant išorinius įnašus.
Patvirtinimas fiksuojamas PR šablono varnele.

Prisidedantiesiems taip pat privaloma nurodyti, jei kodui generuoti buvo
naudoti AI įrankiai. Tai ne kliūtis, o tas pats skaidrumo standartas, kurio
laikomasi šiame dokumente.

---

## Trečiųjų šalių komponentai

Stenograma naudoja atvirojo kodo bibliotekas ir modelius (faster-whisper,
pyannote.audio, Node ir Python paketus) su savo licencijomis. Šio dokumento
teiginiai apie autorystę taikomi **Stenograma kodui**, ne priklausomybėms.

Kai kurie modeliai (pvz. pyannote „gated" modeliai) reikalauja atskirai priimti
tiekėjo sąlygas — nei EUPL, nei komercinė Stenograma licencija to nepakeičia.

---

## Kontaktai

Klausimai dėl autorystės, licencijavimo ar teisių: **juliana.vorono@gmail.com**
EOF_AUTHORSHIP
  ok "AUTHORSHIP.md sukurtas"
fi

# --- .github/pull_request_template.md -------------------------------------
#
# Be šito CONTRIBUTING.md tekstas lieka vien deklaracija: sunku įrodyti, kad
# prisidedantysis jį apskritai matė. Varnelė PR aprašyme palieka įrašą.

mkdir -p .github

if [ -f .github/pull_request_template.md ]; then
  grep -qF 'Įnašo licencijavimas (privaloma)' .github/pull_request_template.md \
    || die "PR šablonas yra, bet be įnašo licencijavimo varnelės. Peržiūrėkite arba pašalinkite jį ir paleiskite iš naujo."
  skip "PR šablonas jau atitinka v1.3.0"
else
  cat > .github/pull_request_template.md <<'EOF_PRTPL'
## Ką keičia šis PR

<!-- Trumpai: kokia problema ir kodėl šis sprendimas. -->

## Patikrinimai

- [ ] `cd backend && npm test` praeina
- [ ] `cd frontend && npx vitest run` praeina
- [ ] Jei pakeitimas liečia dokumentacijoje nurodytą faktą (skaičių, kintamojo
      vardą, komandą) — dokumentacija atnaujinta tame pačiame PR

## Įnašo licencijavimas (privaloma)

- [ ] Perskaičiau [CONTRIBUTING.md](../CONTRIBUTING.md) ir **sutinku su įnašų
      licencijavimo sąlygomis**: patvirtinu, kad kodas yra mano ir turiu teisę
      jį pateikti, ir suteikiu projekto prižiūrėtojai teisę šį įnašą naudoti,
      modifikuoti ir platinti bet kokia licencija, įskaitant komercinę.
- [ ] Nurodžiau žemiau, jei kodui generuoti naudojau AI įrankius.

<!-- AI įrankiai (jei naudoti): -->
EOF_PRTPL
  ok ".github/pull_request_template.md"
fi

# =========================================================================
# 7/8  Repozitorijos higiena
# =========================================================================
#
# Šaknyje guli vienkartiniai issue kūrimo skriptai ir asmeninės diegimo
# instrukcijos. Jie nėra klaida, bet šaknis yra pirmas dalykas, kurį mato
# vertintojas. Failai NETRINAMI - tik perkeliami.

say "7/8  Šaknies tvarkymas (failai perkeliami, ne trinami)"

mkdir -p scripts/dev docs/releases

move() { # failas, katalogas
  if [ -f "$1" ]; then
    git mv "$1" "$2/" 2>/dev/null && ok "$1 -> $2/" || skip "$1 — perkelti nepavyko"
  else
    skip "$1 nerastas (jau perkeltas?)"
  fi
}

for f in create-operational-readiness.sh create-pilot-validation.sh \
         create-security-issues.sh setup-gdpr-issues.sh \
         setup-github-project.sh setup-labels.sh setup-project-fields.sh \
         issues.txt; do
  move "$f" scripts/dev
done

move RELEASE_NOTES_v1.0.0.md docs/releases
move RELEASE_NOTES_v1.2.0.md docs/releases
move GITHUB_SETUP.md docs
move GITHUB_SETUP_ANDROID.md docs

if [ ! -f scripts/dev/README.md ]; then
  cat > scripts/dev/README.md <<'EOF_DEVREADME'
# Vienkartiniai kūrimo skriptai

Šie skriptai buvo naudoti GitHub issue'ams, etiketėms ir projekto lentai
sukurti kūrimo eigoje. Jie **nereikalingi** norint paleisti ar diegti
Stenograma — laikomi tik istorijai ir pakartotiniam naudojimui.

Diegimui naudokite `setup.sh` repozitorijos šaknyje arba `make help`.
EOF_DEVREADME
  ok "scripts/dev/README.md"
fi

# =========================================================================
# 8/8  CHANGELOG
# =========================================================================

say "8/8  CHANGELOG.md"

if grep -qF "## v1.3.0" CHANGELOG.md 2>/dev/null; then
  skip "CHANGELOG jau turi v1.3.0 įrašą"
else
  cat > .changelog-entry.tmp <<'EOF_CHANGELOG'
## v1.3.0 – licencijos modelis ir dokumentacijos tikslumas

Funkcinių pakeitimų nėra. Šis leidimas sutvarko tris dalykus, kurie iki šiol
buvo netikslūs: licenciją, autorių teisių turėtoją ir dokumentacijoje
nurodytus skaičius.

### Changed

**Licencija: MIT → EUPL-1.2-or-later.** Nuo šios versijos projektas platinamas pagal
European Union Public Licence 1.2 – Europos Komisijos parengtą, OSI patvirtintą
reciprokinę licenciją su oficialiu lietuvišku vertimu.

Versijavimo politika nurodyta vienodai visuose dokumentuose: **EUPL-1.2 arba,
gavėjo pasirinkimu, vėlesnė Komisijos patvirtinta EUPL versija**
(EUPL-1.2-or-later; SPDX identifikatorius `EUPL-1.2`). `LICENSE` tekstas paimtas
iš SPDX license-list-data canonical šaltinio be perrašymo.

**Versijos iki `v1.2.0` imtinai lieka MIT.** Ta licencija neatšaukiama ir toms
versijoms galioja neterminuotai – tai aiškiai užfiksuota `LICENSE-HISTORY.md`,
o originalus tekstas išsaugotas `LICENSE-MIT`.

**Autorių teisių turėtoja nurodyta tiksliai:** Juliana Vorono-Baranovska.
Anksčiau `LICENSE` faile buvo įrašyta „Stenograma" – subjektas, kuris teisiškai
neegzistuoja ir negalėtų būti sutarties šalimi.

### Fixed

Dokumentacijoje nurodyti skaičiai atsiliko nuo realybės. Patikrinta paleidus
testus ir ištaisyta:

- backend testų skaičius: `558` → **1042** (README trijose vietose);
- backend/README: `107` → **1042**;
- frontend testų skaičius: `24` → **64** (6 failai, įskaitant
  `src/api/stenogramaApi.test.js`, kurio aprašyme apskritai nebuvo);
- Node.js versija README ir RUNPOD.md: `20` → **22**. CHANGELOG v1.2.0 teigė,
  kad versija pakeista „visose vietose" – iš tikrųjų README ir RUNPOD.md liko
  su senu skaičiumi.

Tai nėra kosmetika: šio projekto pagrindinis argumentas yra tas, kad
dokumentacija atitinka kodą. Neteisingas skaičius README pirmoje lentelėje
kenkia labiau nei jo nebuvimas.

### Added

- `CONTRIBUTING.md` su įnašų licencijavimo sąlygomis ir
  `.github/pull_request_template.md` su patvirtinimo varnele – jie užtikrina,
  kad priimant išorinius įnašus projektas išsaugotų dvigubos licencijos
  modeliui reikalingas relicencijavimo teises. Šiuo metu išorinių įnašų nėra,
  tad modelis veikia ir be jų – bet pirmas priimtas PR be teisių suteikimo
  situaciją pakeistų. Tai lengvasvoris susitarimas, ne pasirašytas CLA –
  taip ir įvardyta.
- `LICENSE-COMMERCIAL.md` – kada EUPL pakanka ir kada reikia atskiros
  licencijos, su kontaktais.
- `SECURITY.md` – pridėtas realus kontaktinis el. paštas (anksčiau buvo tik
  „contact the maintainer privately", nenurodant kaip).
- `AUTHORSHIP.md` – kas projektą sukūrė, kaip jis kurtas (AI įrankiai su žmogaus
  priežiūra), ir ką reiškia kelios commit'ų tapatybės git istorijoje. Visos jos
  priklauso tai pačiai autorei; išorinių prisidėjusių asmenų nėra. Dokumentas
  atsako į klausimus, kuriuos vertintojas vis tiek užduotų – geriau iš karto ir
  tiksliai, nei vėliau ir spėliojant.

### Housekeeping

Šaknyje gulėję vienkartiniai issue kūrimo skriptai perkelti į `scripts/dev/`,
leidimo pastabos į `docs/releases/`, GitHub diegimo instrukcijos į `docs/`.
Nieko neištrinta.

---

EOF_CHANGELOG
  awk -v secfile=".changelog-entry.tmp" '
    !done && $0 ~ /^## v1\.2\.0/ {
      while ((getline line < secfile) > 0) print line
      done = 1
    }
    { print }
  ' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
  if grep -qF "## v1.3.0" CHANGELOG.md; then ok "CHANGELOG v1.3.0 įrašas"; else skip "CHANGELOG — pridėkite ranka"; fi
  rm -f .changelog-entry.tmp
fi

# =========================================================================
# Commit
# =========================================================================

printf '\n'
say "Git commit"

# TIK skripto valdomi failai. Jokio `git add -A` — untracked artefaktai
# (.env, audio, eksportai, tokenai) neturi patekti į commit'ą net per klaidą.
# git mv jau sustage'ino perkeltus failus.

# Sąrašas TAS PATS, kuris naudotas untracked patikroje skripto pradžioje
# (MANAGED_FILES). Jei jie išsiskirtų, patikra nustotų galioti.
printf '%s\n' "$MANAGED_FILES" | while IFS= read -r f; do
  [ -n "$f" ] && [ -e "$f" ] && git add "$f"
done

# Saugiklis: jei tarp sustage'intų failų atsirado kas nors netikėto, sustojam.
UNEXPECTED="$(git diff --cached --name-only | grep -E '(^|/)\.env|\.(wav|mp3|m4a|mp4|webm|ogg|flac)$|token|secret' || true)"
if [ -n "$UNEXPECTED" ]; then
  say "SUSTABDYTA: tarp komituojamų failų yra įtartinų:"
  printf '%s\n' "$UNEXPECTED"
  die "Peržiūrėkite (git restore --staged <failas>) ir paleiskite iš naujo."
fi

if git diff --cached --quiet; then
  skip "Nėra ką komituoti"
else
  git commit -q -F - <<'EOF_MSG2'
release: v1.3.0 — EUPL-1.2-or-later licencija ir dokumentacijos tikslinimas

Licencija
- MIT -> EUPL-1.2-or-later nuo v1.3.0 (SPDX id: EUPL-1.2); versijos iki
  v1.2.0 imtinai lieka MIT
  (neatšaukiama, užfiksuota LICENSE-HISTORY.md, tekstas LICENSE-MIT)
- autorių teisių turėtoja: Juliana Vorono-Baranovska (anksčiau LICENSE
  nurodė „Stenograma" — teisiškai neegzistuojantį subjektą)
- CONTRIBUTING.md su įnašų licencijavimo sąlygomis + PR šablono varnelė
  (išsaugo relicencijavimo teises priimant išorinius įnašus)
- LICENSE-COMMERCIAL.md, SECURITY.md kontaktas
- AUTHORSHIP.md: autorystė, AI įrankių naudojimas, commit tapatybių
  paaiškinimas (visos priklauso tai pačiai autorei)

Dokumentacijos tikslumas (patikrinta paleidus testus)
- backend testai: 558 -> 1042; backend/README: 107 -> 1042
- frontend testai: 24 -> 64
- Node.js: 20 -> 22 README ir RUNPOD.md (v1.2.0 CHANGELOG klaidingai
  teigė, kad pakeista „visose vietose")

Higiena
- vienkartiniai issue skriptai -> scripts/dev/, release notes ->
  docs/releases/, GitHub instrukcijos -> docs/ (nieko neištrinta)
- package.json / package-lock.json versijos 1.2.0 -> 1.3.0
EOF_MSG2
  ok "Commit sukurtas"
fi

say "Žyma v1.3.0"
if git rev-parse v1.3.0 >/dev/null 2>&1; then
  # Nepakanka konstatuoti, kad žyma yra: jei ji rodo į kitą commit'ą,
  # release'as būtų neteisingas ir tai paaiškėtų tik po push.
  if [ "$(git rev-list -n1 v1.3.0)" = "$(git rev-parse HEAD)" ]; then
    skip "Žyma v1.3.0 jau rodo į šį commit'ą"
  else
    die "Žyma v1.3.0 jau egzistuoja ir rodo į KITĄ commit'ą ($(git rev-list -n1 --abbrev-commit v1.3.0)). Patikrinkite: git show v1.3.0"
  fi
else
  git tag -a v1.3.0 -m "v1.3.0 — EUPL-1.2-or-later licencija ir dokumentacijos tikslinimas"
  ok "v1.3.0"
fi

printf '\n'
say "Paruošta. PRIEŠ push rekomenduojama:"
printf '    git show --stat HEAD\n'
printf '    cd backend && npm test\n\n'
say "Jei viskas gerai:"
printf '    git push && git push --tags\n\n'
printf 'Skriptas NIEKO nenusiuntė. Atšaukti:\n'
printf '    git reset --hard HEAD~1 && git tag -d v1.3.0\n'
