[33mcommit 10e54edd0a30363163e7b2445f65c0734320831d[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m)[m
Author: forevercornix <juliana.vorono@gmail.com>
Date:   Mon Aug 10 18:33:56 2026 +0300

    docs(changelog): v1.3.0 įraše nurodomas commit'ų skaičius
    
    Ankstesnis commit'as (d641922) įrašo apimtį aprašė tik failais ir
    eilutėmis, o jo aprašyme nurodytas commit'ų skaičius (69) buvo klaidingas:
    jis išmatuotas intervale v1.2.0..HEAD prieš release commit'ą, o ne
    v1.2.0..v1.3.0.
    
    Tikras skaičius: 70 commit'ai (36 be merge). Pridėta ir eilutė,
    nurodanti, kokiame intervale skaičiai matuoti - kad kitą kartą nereikėtų
    spėlioti.

[1mdiff --git a/CHANGELOG.md b/CHANGELOG.md[m
[1mindex 1e134bf..2264f05 100644[m
[1m--- a/CHANGELOG.md[m
[1m+++ b/CHANGELOG.md[m
[36m@@ -6,8 +6,11 @@[m [mProjekto raidos milestone'ai. Formatas grubiai pagal [Keep a Changelog](https://[m
 [m
 ## v1.3.0 – Milestone 2: prieiga, duomenų valdymas ir operacinis pasirengimas[m
 [m
[31m-Didžiausias leidimas iki šiol: **145 failai, +24 013 / −1 376 eilutės**. Backend[m
[31m-testų nuo 558 iki **1042**, frontend nuo 55 iki **64**.[m
[32m+[m[32mDidžiausias leidimas iki šiol: **70 commit'ai** (36 be merge), **145 failai,[m
[32m+[m[32m+24 013 / −1 376 eilutės**. Backend testų nuo 558 iki **1042**, frontend nuo[m
[32m+[m[32m55 iki **64**.[m
[32m+[m
[32m+[m[32mSkaičiai matuoti intervale `v1.2.0..v1.3.0`.[m
 [m
 Kryptis ta pati, kaip v1.2.0: ne naujos vartotojo funkcijos, o **prielaidų[m
 pavertimas tikrinamomis garantijomis** – tik šįkart ne privatumo, o prieigos,[m
