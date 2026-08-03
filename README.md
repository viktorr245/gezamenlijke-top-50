# Gezamenlijke top 50

Een website waarmee Viktor, Daniel, Keano, Sander en Jurjan ieder twintig nummers aanleveren en samen bepalen welke vijftig nummers op drie cd’s komen.

## Zo werkt het

De website loopt vanzelf door drie fases. Het startadres opent automatisch de pagina die bij de actuele fase hoort: **Mijn 20**, **Stemmen** of **Ranglijst**.

### 1. Iedereen levert twintig nummers in

Kies eerst links of bovenin je eigen naam. Op **Mijn 20** kun je daarna:

- zoeken op titel, artiest of album;
- een resultaat uit de Nederlandse iTunes Store toevoegen;
- een nummer dat niet in iTunes staat handmatig toevoegen met titel, artiest en eventueel een album;
- de iTunes-preview beluisteren als die beschikbaar is;
- per nummer een volledig audiobestand kiezen of naar de kaart slepen;
- het geüploade bestand afspelen en door de tijdlijn scrubben;
- een verkeerd nummer weer verwijderen.

De lijst wordt na iedere wijziging centraal op de server bewaard. Een nummer kan maar door één deelnemer worden ingediend. De knop **Inzending definitief maken** wordt pas actief bij precies twintig nummers én twintig audiobestanden. Na bevestigen kunnen de nummers niet meer worden gewijzigd.

### 2. Iedereen maakt 120 vergelijkingen

Stemmen opent zodra alle vijf inzendingen compleet en definitief zijn. Iedere deelnemer ziet steeds twee nummers van andere deelnemers, kan beide volledig beluisteren en kiest er één.

- Er is één doorlopende lijst van 120 vergelijkingen; er zijn geen rondes.
- De voortgang staat op de server, dus je kunt stoppen en later op hetzelfde of een ander apparaat verdergaan.
- Na keuze 120 krijg je eerst een controlescherm. Daar kun je de laatste keuze aanpassen of je stemmen definitief maken.
- Totdat je zelf bevestigt, kun je keuzes stap voor stap terugnemen. Na bevestigen staan jouw stemmen vast.
- De ranglijst blijft verborgen totdat alle vijf deelnemers hun 120 keuzes hebben bevestigd. Zo beïnvloedt een tussenstand latere keuzes niet.

Het schema is vooraf en deterministisch opgebouwd. Per deelnemer komt ieder van de tachtig toegestane nummers precies drie keer voorbij. Over de hele groep wordt ieder nummer twaalf keer beoordeeld: tegen iedere andere inzending drie keer, zes keer links en zes keer rechts. Dezelfde combinatie van twee nummers komt niet opnieuw voor.

### 3. Ranglijst en cd-indeling

Na in totaal 600 keuzes en vijf definitieve bevestigingen berekent de server de volledige ranglijst. De vijftig geselecteerde nummers staan boven **De streep**. Daarna:

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

Bij een handmatig toegevoegd nummer hoef je geen speelduur in te vullen. FFprobe leest die automatisch uit zodra het audiobestand wordt geüpload; deze gemeten duur wordt daarna in de inzending en de interface gebruikt.

## Zoeken en cachen

Zoeken gebruikt de gratis iTunes Search API van Apple en heeft geen API-sleutel nodig. De browser vraagt Apple nooit rechtstreeks aan: alle verzoeken lopen via de eigen server.

- Zoekresultaten blijven zeven dagen in de schijfcache.
- De oudste niet-vastgezette zoekopdrachten worden opgeruimd zodra de cache meer dan 500 zoekopdrachten bevat.
- Gelijktijdige gelijke zoekopdrachten worden samengevoegd tot één Apple-verzoek.
- Bij een tijdelijke Apple-storing mag een oudere cacheversie worden gebruikt.
- Zodra een nummer wordt toegevoegd, bewaart de server zowel de gebruikte velden als het volledige oorspronkelijke Apple-record permanent in de lokale catalogus.

Daardoor hoeven de vijf deelnemers dezelfde gegevens niet steeds opnieuw bij Apple op te vragen.

Een handmatig toegevoegd nummer gebruikt geen Apple-verzoek. De ingevoerde gegevens staan rechtstreeks in het centrale concept en het nummer volgt daarna dezelfde regels als een iTunes-nummer: het mag maar één keer in de groep voorkomen en er moet vóór het definitief maken een volledig audiobestand zijn toegevoegd.

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

Zonder pincodeconfiguratie start de website in **vertrouwde lokale modus**. Je kunt dan in de interface tussen deelnemers wisselen. Gebruik die modus alleen lokaal of op een afgeschermd privénetwerk. Met `npm run auth:generate` maakt de website lokaal een `.env` en `pincodes.local.txt` met vijf unieke pincodes; beide bestanden worden door Git genegeerd.

De productiebuild maken en starten:

```bash
npm run build
npm run preview
```

Met `FFMPEG_PATH=/pad/naar/ffmpeg` en `FFPROBE_PATH=/pad/naar/ffprobe` kun je andere installaties aanwijzen.

### Met Docker

De meegeleverde `Dockerfile` bouwt de Astro-server en bevat FFmpeg, FFprobe en een container-healthcheck. Start hem met een blijvend opslagvolume en een zelf gegenereerde `.env`:

```bash
npm run auth:generate
docker build -t gezamenlijke-top-50 .
docker run --rm \
  --env-file .env \
  -e HOST=0.0.0.0 \
  -e PORT=4321 \
  -e STORAGE_DIR=/data \
  -p 4321:4321 \
  -v gezamenlijke-top-50-data:/data \
  gezamenlijke-top-50
```

Gebruik in productie precies één container tegelijk. De JSON-opslag en schrijfwachtrijen zijn ontworpen voor één serverproces.

## Aanmelden en deelnemersrechten

Voor een server die via internet bereikbaar is, stel je pincode-login in met twee omgevingsvariabelen:

```bash
npm run auth:generate
npm run preview
```

Dit maakt een niet-gecommitte `.env` met een willekeurig sessiegeheim en vijf unieke pincodes, plus `pincodes.local.txt` om de codes privé te verdelen. Zodra `MEMBER_PINS` is ingesteld:

- moet iedere deelnemer zich aanmelden met naam en pincode;
- bewaart de browser alleen een ondertekende `HttpOnly`-sessiecookie;
- kan een deelnemer alleen zijn eigen inzending, audio en stemmen aanpassen;
- kan alleen Viktor de cd-indeling aanpassen, definitief maken en brandpakketten opnieuw opbouwen;
- worden niet-aangemelde pagina- en API-verzoeken geweigerd.

`AUTH_SECRET` moet dan minimaal 32 tekens bevatten. `MEMBER_PINS` moet voor alle vijf deelnemers een unieke pincode van minimaal vier tekens bevatten. Na acht mislukte pogingen voor dezelfde deelnemer en hetzelfde IP-adres wacht de server vijftien minuten voordat nieuwe pogingen worden geaccepteerd. Die limiet leeft in het geheugen van één serverproces.

Staat de website achter een eigen reverse proxy, zet dan `TRUST_PROXY=true` en configureer die proxy zo dat hij inkomende `X-Forwarded-For`- en `X-Real-IP`-headers **overschrijft**. Zonder deze garantie moet `TRUST_PROXY` uit blijven; de server gebruikt dan veilig het directe socketadres.

Wanneer de proxy publieke HTTPS intern als HTTP doorstuurt, stel je daarnaast de exacte publieke origin in, bijvoorbeeld `PUBLIC_ORIGIN=https://degezamenlijke50.boe.moe`. Daarmee blijven de Origin-controles op schrijvende verzoeken correct achter de proxy. Geef alleen de origin op: geen pad, querystring of fragment.

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

Viktor kan onderaan **De cd’s** de serveropslag openklappen. Daar staat hoeveel opslag in gebruik en beschikbaar is, of er een opslaglimiet geldt en wanneer in de back-upmap voor het laatst een bestand is gewijzigd. De website maakt zelf geen back-ups; plaats je back-upbestanden standaard in `storage/backups/` of wijs met `BACKUP_DIR` een andere map aan.

De server controleert vóór een audio-upload en vóór het maken van brandpakketten of er genoeg ruimte overblijft. Instelbare grenzen:

| Variabele | Betekenis | Standaard |
| --- | --- | --- |
| `STORAGE_QUOTA_GB` | Maximale totale opslag voor de website | geen vaste limiet |
| `MIN_FREE_STORAGE_MB` | Vrije ruimte die na een bewerking minimaal over moet blijven | 512 MB |
| `BACKUP_DIR` | Map waarin de website de nieuwste back-up zoekt | `storage/backups/` |

Een nieuwe set van vijf definitieve inzendingen krijgt automatisch een nieuwe stemcampagne. Een oude cd-indeling wordt alleen hergebruikt als hij exact bij de huidige top 50 hoort.

## API-routes

| Route | Functie |
| --- | --- |
| `POST /api/auth/login` | aanmelden en een ondertekende sessie starten |
| `POST /api/auth/logout` | sessie beëindigen |
| `GET /api/auth/session` | actieve authenticatiemodus en deelnemer laden |
| `GET /api/status` | fase en voortgang van alle deelnemers |
| `GET /api/storage-status` | opslag- en back-upstatus voor Viktor |
| `GET/PUT/POST /api/submissions/:memberId` | concept laden, concept bewaren, definitief maken |
| `GET/POST/PUT/DELETE /api/voting/:memberId` | huidige vergelijking laden, keuze opslaan, stemmen definitief maken of laatste keuze terugnemen |
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
- de fase-afhankelijke doorverwijzing vanaf het startadres;
- ondertekende sessies en het blokkeren van toegang tot een andere deelnemer;
- de 120 voortgangsmarkeringen, stemmen, terugnemen en expliciet definitief maken;
- zoeken, audioverplichting en het ontbreken van een betekenisloze inzendvolgorde;
- alle honderd ranglijstregels en de grens na nummer 50;
- automatische cd-verdeling, toegankelijke verplaatsing en definitief maken;
- geldige streaming-ZIP’s met Unicode-bestandsnamen en de brandpakketdownloads;
- het ontbreken van document-scroll en horizontale overflow op de geteste schermgroottes.
