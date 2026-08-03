# Gezamenlijke top 50

Een website waarmee Viktor, Daniel, Keano, Sander en Jurjan ieder twintig nummers aanleveren en samen bepalen welke vijftig nummers op drie cd’s komen.

## Zo werkt het

De website loopt vanzelf door drie fases.

### 1. Iedereen levert twintig nummers in

Kies eerst links of bovenin je eigen naam. Op **Mijn 20** kun je daarna:

- zoeken op titel, artiest of album;
- een resultaat uit de Nederlandse iTunes Store toevoegen;
- de iTunes-preview beluisteren als die beschikbaar is;
- per nummer een volledig audiobestand kiezen of naar de kaart slepen;
- het geüploade bestand afspelen en door de tijdlijn scrubben;
- een verkeerd nummer weer verwijderen.

De lijst wordt na iedere wijziging centraal op de server bewaard. Een nummer kan maar door één deelnemer worden ingediend. De knop **Inzending definitief maken** wordt pas actief bij precies twintig nummers én twintig audiobestanden. Na bevestigen kunnen de nummers niet meer worden gewijzigd.

### 2. Iedereen maakt 120 vergelijkingen

Stemmen opent zodra alle vijf inzendingen compleet en definitief zijn. Iedere deelnemer ziet steeds twee nummers van andere deelnemers, kan beide volledig beluisteren en kiest er één.

- Er is één doorlopende lijst van 120 vergelijkingen; er zijn geen rondes.
- De voortgang staat op de server, dus je kunt stoppen en later op hetzelfde of een ander apparaat verdergaan.
- De laatste keuze kan worden teruggenomen zolang de hele groep nog niet klaar is.
- De ranglijst blijft verborgen totdat alle vijf deelnemers klaar zijn. Zo beïnvloedt een tussenstand latere keuzes niet.

Het schema is vooraf en deterministisch opgebouwd. Per deelnemer komt ieder van de tachtig toegestane nummers precies drie keer voorbij. Over de hele groep wordt ieder nummer twaalf keer beoordeeld: tegen iedere andere inzending drie keer, zes keer links en zes keer rechts. Dezelfde combinatie van twee nummers komt niet opnieuw voor.

### 3. Ranglijst en cd-indeling

Na de laatste van in totaal 600 keuzes berekent de server de volledige ranglijst. De vijftig geselecteerde nummers staan boven **De streep**. Daarna:

1. leest de server met FFprobe de werkelijke lengte van de originele audiobestanden;
2. verdeelt de website de top 50 automatisch over drie cd’s, steeds met het langste resterende nummer op de op dat moment kortste cd;
3. bewaakt de website de grens van 80 minuten per cd, inclusief twee seconden tussen opeenvolgende tracks;
4. kan Viktor nummers naar een andere cd verplaatsen en de volgorde aanpassen;
5. controleert de server de werkelijke lengtes nogmaals bij definitief maken;
6. maakt de server drie brandklare downloadpakketten.

De andere deelnemers kunnen de indeling en downloads wel bekijken. Een definitieve indeling kan via de website niet meer worden gewijzigd.

Ieder cd-pakket is een ZIP met genummerde WAV-bestanden in de vastgelegde volgorde, een UTF-8 M3U8-afspeellijst, een CUE-bestand en `Tracklijst.txt`. De WAV-bestanden zijn 44,1 kHz, 16-bit stereo en worden rechtstreeks vanuit de originele uploads gemaakt. Daarnaast is er één download met de pakketten van alle drie cd’s. De pagina toont tijdens het maken per nummer de voortgang. Als de voorbereiding mislukt, kan Viktor die opnieuw starten.

## Hoe de top 50 wordt berekend

De uitslag gebruikt geen live Elo-score. Elo is gevoelig voor de volgorde waarin stemmen binnenkomen en past daarom minder goed wanneer iedereen op een eigen moment stemt.

De server berekent alle 600 keuzes tegelijk met een geregulariseerd Bradley–Terry-model. Dat model schat voor ieder nummer een onderliggende sterkte op basis van de gewonnen en verloren vergelijkingen. Een zwakke statistische prior voorkomt extreme scores bij weinig informatie.

Daarna trekt de server 2.000 steekproeven uit de benaderde posteriorverdeling. Per nummer worden onder meer berekend:

- de kans om in de top 50 te eindigen;
- de verwachte positie;
- een 90%-interval voor de positie;
- de gewone winratio als controle;
- vijf controles waarbij telkens de stemmen van één deelnemer worden weggelaten.

De vijftig nummers met de grootste top-50-kans worden gekozen. Bij een gelijke kans volgen verwachte positie, geschatte sterkte en een vaste technische sorteersleutel. De berekening is daardoor reproduceerbaar en onafhankelijk van de volgorde waarin de stemmen zijn opgeslagen. Er zijn geen quota per deelnemer en stemmen van alle deelnemers wegen even zwaar.

## Audio

Ondersteunde uploads zijn MP3, M4A, WAV, OGG, WebM, AAC en FLAC, met een maximum van 100 MB per bestand.

Bij een upload bewaart de server:

- het originele bestand, ongewijzigd;
- een WebM/Opus-versie van 196 kbit/s voor afspelen in de browser.

Verwijder je een nummer uit een conceptinzending, dan verwijdert de server beide audiobestanden direct mee. Audio van een definitieve inzending kan niet via de website worden verwijderd.

FFmpeg voert de conversies uit en FFprobe leest vóór het definitief maken de werkelijke speelduur. Voor de 80-minutencontrole reserveert de server ook twee seconden tussen opeenvolgende tracks. De afspeel- en downloadroutes ondersteunen byte ranges, zodat vooruitspoelen en het hervatten van grote downloads goed werken.

## Zoeken en cachen

Zoeken gebruikt de gratis iTunes Search API van Apple en heeft geen API-sleutel nodig. De browser vraagt Apple nooit rechtstreeks aan: alle verzoeken lopen via de eigen server.

- Zoekresultaten blijven zeven dagen in de schijfcache.
- Gelijktijdige gelijke zoekopdrachten worden samengevoegd tot één Apple-verzoek.
- Bij een tijdelijke Apple-storing mag een oudere cacheversie worden gebruikt.
- Zodra een nummer wordt toegevoegd, bewaart de server zowel de gebruikte velden als het volledige oorspronkelijke Apple-record permanent in de lokale catalogus.

Daardoor hoeven de vijf deelnemers dezelfde gegevens niet steeds opnieuw bij Apple op te vragen.

## Techniek

- Astro met de Node-adapter
- TypeScript
- HTML en CSS
- Phosphor Icons
- Playwright
- FFmpeg met `libopus` en FFprobe

De server bewaart de gegevens als atomair geschreven JSON-bestanden en audiobestanden. Dit past bij één kleine vriendengroep en één draaiend serverproces. Voor meerdere gelijktijdige server-instances hoort de opslag door een database en gedeelde object storage te worden vervangen.

## Lokaal starten

Vereist:

- Node.js 22 of nieuwer;
- FFmpeg met ondersteuning voor `libopus`, inclusief FFprobe.

```bash
npm install
npm run dev
```

De productiebuild maken en starten:

```bash
npm run build
npm run preview
```

Met `FFMPEG_PATH=/pad/naar/ffmpeg` en `FFPROBE_PATH=/pad/naar/ffprobe` kun je andere installaties aanwijzen.

## Opslag en back-ups

Standaard schrijft de server alles naar `storage/`:

| Bestand of map | Inhoud |
| --- | --- |
| `submissions.json` | concepten en definitieve inzendingen |
| `votes.json` | de campagnesleutel en alle ruwe keuzes |
| `disc-layout.json` | de concept- of definitieve cd-indeling |
| `itunes-cache.json` | zoekcache en vastgezette Apple-records |
| `audio-index.json` | metadata van geüploade audio |
| `audio/` | originele bestanden en Opus-versies |
| `burn-packages/` | brandklare ZIP’s voor een definitieve cd-indeling |

Gebruik op een server een blijvend, beschrijfbaar volume en maak van de hele map één back-up. Met `STORAGE_DIR=/pad/naar/opslag` kies je een andere locatie. `AUDIO_STORAGE_DIR` wordt nog als oude naam geaccepteerd.

Een nieuwe set van vijf definitieve inzendingen krijgt automatisch een nieuwe stemcampagne. Een oude cd-indeling wordt alleen hergebruikt als hij exact bij de huidige top 50 hoort.

## Rollen en beveiliging

De gekozen naam wordt alleen in `localStorage` van de browser bewaard. Er zijn geen accounts of wachtwoorden. De server controleert wel dat alleen de gekozen organisator-id `viktor` de cd-indeling aanpast, definitief maakt en een mislukte pakketopbouw opnieuw start, maar dat is geen echte authenticatie.

Gebruik deze versie daarom op een vertrouwde privéserver voor de vijf deelnemers. Voeg echte aanmelding en autorisatie toe voordat de site openbaar bereikbaar wordt.

## API-routes

| Route | Functie |
| --- | --- |
| `GET /api/status` | fase en voortgang van alle deelnemers |
| `GET/PUT/POST /api/submissions/:memberId` | concept laden, concept bewaren, definitief maken |
| `GET/POST/DELETE /api/voting/:memberId` | huidige vergelijking, keuze opslaan, laatste keuze terugnemen |
| `GET /api/ranking` | definitieve batchranglijst zodra iedereen klaar is |
| `GET/PUT/POST /api/disc-layout` | indeling laden, automatisch bewaren, definitief maken |
| `GET/POST /api/burn-packages` | voortgang laden of pakketopbouw opnieuw starten |
| `GET /api/burn-packages/:packageId` | één cd of alle cd-pakketten downloaden |
| `GET /api/itunes/search` | gecachet zoeken bij iTunes |
| `GET/POST /api/itunes/catalog` | vastgezette catalogus laden of een volledig Apple-record permanent vastzetten |
| `GET /api/audio` | overzicht van beschikbare audiobestanden |
| `GET/POST/DELETE /api/audio/:trackId` | audio afspelen, uploaden of uit een concept verwijderen |

Schrijvende routes weigeren verzoeken met een vreemde `Origin`.

## Testen

```bash
npm run build
npm test
```

De tests controleren onder meer:

- alle wiskundige balansvoorwaarden van het 600-vergelijkingenschema;
- determinisme en invoervolgorde-onafhankelijkheid van de batchranglijst;
- centrale conceptopslag, groepsbrede duplicaten en definitief vergrendelen;
- navigatie en deelnemerkeuze op desktop en mobiel;
- de 120 voortgangsmarkeringen, stemmen en terugnemen;
- zoeken, audioverplichting en het ontbreken van een betekenisloze inzendvolgorde;
- alle honderd ranglijstregels en de grens na nummer 50;
- automatische cd-verdeling, toegankelijke verplaatsing en definitief maken;
- geldige streaming-ZIP’s met Unicode-bestandsnamen en de brandpakketdownloads;
- het ontbreken van document-scroll en horizontale overflow op de geteste schermgroottes.
