# Informativa sulla protezione dei dati

**OpenVolley e OpenBeach** · Versione 1.0 · Aggiornata al 7 ottobre 2026

Questa informativa esiste in tedesco, inglese, francese e italiano. Fa fede
la versione tedesca.

## In breve

- OpenVolley è un progetto open source privato e non commerciale. Non ci sono
  pubblicità, tracciamento, strumenti di analisi né cookie.
- Le app funzionano offline. Le sue partite sono salvate sul suo dispositivo,
  e nella banca dati del server solo dopo l'accesso. Affinché i tablet
  ricevano una partita in corso, le app browser e Android la fanno passare dal
  mio server anche senza accesso, solo nella memoria di lavoro.
- Un referto elettronico contiene dati di giocatrici e giocatori, staff e
  ufficiali di gara: nomi, numeri di maglia, date di nascita e firme. Sono
  pubblici solo i nomi delle squadre, il punteggio e i numeri di maglia; nel
  beach volley anche i nomi delle giocatrici e dei giocatori, nonché i nomi
  degli arbitri delle partite ufficiali. **Date di nascita, numeri di licenza
  e firme non sono mai pubblici.**
- Il server si trova in Germania (Hetzner). Cloudflare (USA) distribuisce i
  siti web e inoltra il traffico al server.
- Può chiedere in ogni momento informazioni, rettifica o cancellazione:
  **support@openvolley.app**.

## 1. Chi è responsabile

Il titolare del trattamento è:

**Luca Canepa**, persona privata, Svizzera\
Indirizzo postale: vedi le [note legali](impressum.md)\
E-mail: support@openvolley.app

Gestisco OpenVolley come persona privata. Non ho nominato un consulente per la
protezione dei dati; non vi sono tenuto. Per tutte le domande sulla
protezione dei dati scriva a support@openvolley.app.

Questa informativa vale per:

- il sito **openvolley.app** e la pagina di download **get.openvolley.app**;
- le app di refertazione **OpenVolley** (indoor) e **OpenBeach** (beach) nel
  browser, come app desktop (Windows, Linux) e come app Android;
- le viste tablet per arbitro e panchina, il livescore, le pagine delle liste
  squadra e dei referti e i siti di gestione sotto `*.openvolley.app`;
- il server `backend.openvolley.app` con cui le app si sincronizzano.

## 2. Diritto applicabile

Tratto i dati personali secondo la legge federale svizzera sulla protezione
dei dati (LPD, in vigore dal 1° settembre 2023). Se sono coinvolte persone
nell'UE o nello SEE, per esempio giocatrici e giocatori stranieri a un torneo
di beach volley, rispetto anche il regolamento generale sulla protezione dei
dati dell'UE (RGPD). Questa informativa contiene le indicazioni richieste da
entrambe le leggi.

## 3. Principi

- **Nessun cookie.** Le app non impostano cookie. Salvano solo ciò che serve
  per funzionare nella memoria del suo browser o dispositivo (localStorage e
  IndexedDB): i dati delle partite per l'uso offline, le sue impostazioni e,
  se ha effettuato l'accesso, un token di accesso.
- **Nessun tracciamento, nessuna pubblicità, nessuna analisi.** Non ci sono
  strumenti di analisi, invii di segnalazioni di errore a terzi, pubblicità,
  profilazione né decisioni individuali automatizzate. Non vendo dati.
- **Nessun contenuto di terzi.** Caratteri e codice dei programmi provengono
  dai nostri siti, non da server di terzi. Le eccezioni sono indicate
  espressamente (sezione 12).
- **Prima offline.** Ciò che registra senza accedere è salvato solo sul suo
  dispositivo. Per la trasmissione ai tablet, veda la sezione 9.

## 4. Sito web e pagina di download

**openvolley.app** e **get.openvolley.app** sono pagine statiche senza moduli
e senza script di terzi. Quando le apre, Cloudflare tratta i dati
tecnicamente necessari: indirizzo IP, indirizzo richiesto, ora e
identificativo del browser. Il mio server non tiene un registro degli accessi
per get.openvolley.app.

I link a GitHub e F-Droid portano a servizi che sono essi stessi responsabili
del loro trattamento dei dati.

## 5. Le app di refertazione (browser, desktop, Android)

**Senza accesso**, l'app salva tutto solo sul suo dispositivo: partite,
squadre, liste squadra con date di nascita, set, eventi della partita, elenchi
di ufficiali di gara, impostazioni e un registro locale dell'uso (per la
ricerca di errori; può scaricarlo lei stesso). Le partite restano salvate
finché non le cancella o non cancella i dati dell'app.

**Trasmissione in diretta, anche senza accesso.** Appena una partita è
creata, le app browser e Android la inviano (squadre, liste squadra,
punteggio, eventi) al relay in diretta del mio server, affinché i tablet
dell'arbitro e della panchina la ricevano (sezione 9). Lì è tenuta solo nella
memoria di lavoro. L'app desktop usa invece il proprio relay nella rete locale.

**Con accesso**, l'app sincronizza le sue partite con il server (sezione 7).
Inoltre carica:

- **copie di sicurezza** di una partita (complete, con liste squadra, date di
  nascita e firme). Solo il suo account può leggerle. Vengono cancellate dopo
  30 giorni;
- **registri dell'app** (messaggi tecnici dell'app; possono contenere nomi e
  numeri di partita). Solo il suo account può leggerli. Restano salvati fino
  alla cancellazione del suo account;
- i **referti** come file (PDF e dati), vedi sezione 7.

**App desktop.** L'app desktop salva inoltre copie di sicurezza automatiche
delle partite nella sua cartella utente (Linux:
`~/.local/share/OpenVolley/backups`, Windows: `%APPDATA%\OpenVolley\backups`).
Contengono nomi e date di nascita, ma nessun PIN, e vengono cancellate dopo
30 giorni.

**App Android.** L'app Android salva le sue copie di sicurezza nella cartella
pubblica «Documenti». **Questi file restano dopo la disinstallazione dell'app
e, su Android 10 e versioni precedenti, possono essere letti anche da altre
app.** Se necessario, li cancelli lei stesso. Se ha attivato il backup Google
del dispositivo, Android può salvare anche i dati dell'app (con le liste
squadra) nel suo account Google; valgono le condizioni di Google.

Su un dispositivo condiviso, esca dall'account dopo la partita. L'uscita
cancella il token di accesso e le squadre memorizzate temporaneamente.

## 6. Account ed e-mail

Le serve un account per sincronizzare partite, gestire squadre e tornei o
approvare risultati come ufficiale di gara. Gli account si aprono su
`manager.openvolley.app` e `manager-beach.openvolley.app`.

**Dati:** indirizzo e-mail, password (salvata solo come hash, mai in chiaro),
nome e cognome, paese, data di nascita (facoltativa), ruoli (per esempio
segnapunti, arbitro, gestore di competizione), le app per cui vale l'account
(indoor, beach), date di apertura, ultimo accesso e conferma dell'e-mail. I
dati inseriti alla registrazione sono conservati anche come copia presso
l'account.

**Scopo:** accesso, attivazione delle funzioni del suo ruolo e
precompilazione dei suoi dati nel referto (nome, paese, data di nascita).

**I nuovi account** non hanno inizialmente alcun ruolo. Un amministratore li
abilita, oppure lei utilizza un codice d'invito. Il sistema registra chi ha
utilizzato quale codice e quando.

**Accesso:** dopo l'accesso il suo browser salva un token di accesso. Sul
server si trova solo un hash di esso. Una sessione dura 30 giorni dall'ultimo
utilizzo, al massimo 90 giorni, e termina con l'uscita, il cambio della
password e la cancellazione dell'account. Per proteggersi dagli attacchi, il
server conta i tentativi falliti per indirizzo IP e per indirizzo e-mail, solo
nella memoria di lavoro.

**E-mail:** invio solo e-mail legate all'account: conferma dell'indirizzo
e-mail, link per reimpostare la password, avviso di cambio password, avviso
che un risultato è stato approvato con il suo PIN di approvazione e avviso
che il suo PIN è stato bloccato. Non contengono pixel di tracciamento né
immagini caricate da remoto. Un link di conferma vale 24 ore, un link di
reimpostazione 60 minuti.

**Chi vede i dati del suo account:** lei stesso e gli amministratori di
OpenVolley (io e le persone da me designate).

**Cancellare l'account:** può cancellare il suo account in qualsiasi momento
nell'app. Vengono cancellati account, profilo, sessioni, PIN di approvazione,
codici d'invito utilizzati e le sue copie di sicurezza e i registri caricati.
**Restano** i documenti ufficiali a cui altri hanno un interesse: i referti
che ha registrato, le approvazioni che ha dato (con il suo nome come figura
nel referto), le squadre e i tornei salvati e le voci del registro delle
modifiche (sezione 14). Il suo account viene separato da queste voci. Può far
cancellare ciò che resta secondo la sezione 19, nella misura in cui il
referto non ne ha bisogno.

## 7. Dati delle partite e referti

**Contenuto di una partita:** numero della partita, lega, palestra e località,
squadre (nome, nome breve, colore), liste squadra con numero di maglia, nome e
cognome, data di nascita e indicazione libero o capitano, staff (funzione,
nome, data di nascita), ufficiali di gara (arbitri, segnapunti, giudici di
linea con nome, paese, data di nascita), **firme** (immagini disegnate sul
dispositivo), sorteggio, svolgimento della partita con tutti gli eventi,
sostituzioni e sanzioni, risultati e correzioni successive.

**Chi inserisce i dati:** il segnapunti nell'app, i responsabili di squadra
sulla pagina delle liste squadra (`roster.openvolley.app`), i gestori di
competizione tramite le squadre salvate (sezione 10) e le designazioni
ufficiali di Swiss Volley (sezione 11). Le giocatrici e i giocatori non
inseriscono essi stessi i propri dati.

**Scopo:** un referto elettronico per le partite ufficiali: registrazione
durante la partita, verbale ufficiale della partita, controllo
dell'idoneità e della categoria d'età, livescore.

**Chi vede cosa:**

| Chi | Cosa |
|---|---|
| L'account che ha registrato la partita; gli account che hanno inserito il PIN della partita; gli amministratori | Tutto |
| Tablet di arbitro e panchina con PIN | Squadre, liste squadra con nomi e numeri, punteggio. **Nessuna** data di nascita, firma, ufficiale di gara o approvazione |
| Tutti (pubblico) | Vedi sezione 8 |

Una volta approvata e chiusa, una partita non può più essere modificata da
nessuno, nemmeno dalla persona che l'ha registrata. Solo un amministratore
può riaprirla.

**File dei referti:** alla fine della partita l'app carica il referto in PDF e
come file con i dati della partita. Può leggerlo solo l'account che l'ha
caricato (tramite `scoresheet.openvolley.app`) e gli amministratori. Se questo
account viene cancellato, il file resta conservato come verbale della partita,
ma nessuno può più aprirlo finché un amministratore non ripristina l'accesso.

**Approvazione con PIN:** gli ufficiali di gara possono confermare il
risultato, oltre che con la firma, con un PIN di approvazione personale.
Vengono salvati: il PIN come hash crittografico (mai in chiaro), i tentativi
falliti e i blocchi; per ogni approvazione la partita, la funzione (1° o
2° arbitro, segnapunti), il suo account, il suo nome al momento
dell'approvazione, l'ora, il risultato approvato e un hash pseudonimizzato
dell'indirizzo IP e del dispositivo (per riconoscere abusi). Le approvazioni
fanno parte del verbale della partita. Lei vede le sue approvazioni; anche il
segnapunti della partita e gli amministratori le vedono.

**Invio delle info della partita per e-mail:** se nell'app invia le info della
partita a un indirizzo e-mail, numero della partita, PIN della partita,
squadre, data e luogo vengono inviati all'indirizzo inserito. L'indirizzo del
destinatario viene annotato nel registro del server. Per l'invio può essere
utilizzato il servizio Resend (USA) (sezione 15).

## 8. Visualizzazioni pubbliche: livescore, tabelloni LED, dati pubblici

Senza account e senza PIN sono visibili:

- **Livescore** (`livescore.openvolley.app`, `livescore-beach.openvolley.app`)
  e connessioni in diretta: nomi, nomi brevi e colori delle squadre,
  punteggio, set, servizio, formazione, sostituzioni e sanzioni **solo con i
  numeri di maglia**, time-out, lega, palestra, numero della partita. **Nel
  beach volley i nomi delle squadre sono di solito i cognomi delle giocatrici
  e dei giocatori, che sono quindi pubblici.**
- **Tabelloni LED** in palestra: nomi delle squadre e punteggio.
- **Designazioni ufficiali** (sezione 11): dati della partita con i nomi
  degli arbitri e dei giudici di linea, senza date di nascita.
- **Elenco degli arbitri** (sezione 11): nome e cognome, paese, senza date di
  nascita.
- **Tornei di beach volley pubblici** (sezione 10): squadre, nomi, cognomi e
  paesi delle giocatrici e dei giocatori, teste di serie, classifica,
  calendario, campi.

Questi dati sono ottenibili anche tramite l'interfaccia di programmazione del
server (`backend.openvolley.app`).

**Mai pubblici:** date di nascita, numeri di licenza, firme, approvazioni,
indirizzi e-mail e PIN. Le liste squadra con i nomi sono visibili solo a chi
conosce il PIN della partita.

## 9. Tablet e modalità palestra (LAN)

**I tablet di arbitro e panchina** (`referee.`, `bench.`,
`referee-beach.openvolley.app`) si collegano alla partita con un PIN.
Ricevono squadre, liste squadra con nomi e numeri e il punteggio, ma nessuna
data di nascita, firma o dato sugli ufficiali di gara. Il tablet dell'arbitro
salva il PIN e il numero della partita nel browser; cancelli i dati del
browser se il tablet è usato da più persone.

**Tramite il server (relay cloud):** i dati in diretta passano dal mio server.
Li tiene solo nella memoria di lavoro e li elimina 24 ore dopo l'ultima
attività. Ciò vale anche senza accesso.

**Modalità palestra (LAN):** l'app desktop può servire i tablet direttamente
nella rete locale della palestra, anche tramite un hotspot Wi-Fi proprio del
portatile. I dati restano allora nella rete locale e solo nella memoria di
lavoro. Nome e password dell'hotspot sono generati a caso sul suo dispositivo
a ogni avvio. Solo la sincronizzazione con il server lascia la rete locale, e
solo se il segnapunti ha effettuato l'accesso.

**Tabellone LED (LedBox):** un tabellone in palestra può riprendere il
punteggio. Riceve solo nomi delle squadre, punteggio e risultati dei set,
nessun dato di giocatrici o giocatori.

## 10. Siti di gestione: squadre salvate e tornei di beach volley

Su `manager.openvolley.app` e `manager-beach.openvolley.app` i gestori di
competizione possono preparare squadre e tornei.

**Squadre salvate:** nome della squadra, società, giocatrici e giocatori con
numero, nome e cognome, data di nascita, numero di licenza, libero/capitano e
(beach) paese; staff con funzione, nome, data di nascita e numero di licenza.
Visibili agli account con il ruolo di gestore o segnapunti dello sport
corrispondente. Le app di refertazione memorizzano temporaneamente queste
squadre e le cancellano all'uscita.

**Tornei di beach volley:** titolo, luogo, date, squadre con nomi, cognomi,
numeri di licenza e paesi delle giocatrici e dei giocatori, calendario,
risultati, nomi di arbitri e segnapunti. Se un torneo è contrassegnato come
**pubblico**, la pagina pubblica del torneo mostra squadre, nomi e paesi, mai
numeri di licenza o date di nascita.

**Scopo:** riutilizzare le liste squadra, organizzare tornei, abbinare
giocatrici e giocatori tramite il numero di licenza durante l'importazione.

Questi dati restano salvati finché un gestore non li cancella, anche se
l'account che li ha creati viene cancellato.

## 11. Dati sugli arbitri

**Designazioni di Swiss Volley:** ogni giorno il server riprende le
designazioni ufficiali dal VolleyManager di Swiss Volley, per il periodo da
ieri a 14 giorni in avanti: squadre, palestra e indirizzo, lega, 1° e
2° arbitro con nome e data di nascita, giudici di linea, convocazioni. A tal
fine il server usa un account VolleyManager. Scopo: caricare le partite
ufficiali con gli ufficiali di gara corretti. I nomi sono pubblici
(sezione 8); le date di nascita sono visibili solo agli utenti che hanno
effettuato l'accesso.

**Elenco degli arbitri:** un elenco comune con nome e cognome, paese, data di
nascita e sport, affinché il segnapunti non debba inserire ogni volta gli
ufficiali di gara. Gli account con accesso possono aggiungere voci; gli
amministratori possono modificarle e cancellarle. Nomi e paese sono pubblici;
le date di nascita sono visibili solo agli utenti che hanno effettuato
l'accesso.

Se non desidera figurare nell'elenco, scriva a support@openvolley.app.

## 12. Download e aggiornamenti

- **App desktop:** 60 secondi dopo l'avvio, poi ogni 6 ore, all'accesso e su
  richiesta controlla se esiste una nuova versione, mai durante una partita
  in corso. Interroga `get.openvolley.app`, in alternativa GitHub. Viene
  trasmessa solo la richiesta usuale (indirizzo IP, identificativo del
  programma).
- **App Android da F-Droid:** l'app non cerca aggiornamenti da sola; lo fa la
  sua app F-Droid.
- **App Android installata direttamente:** l'app chiede una volta se deve
  cercare aggiornamenti (predefinito: no). Solo se acconsente interroga
  `get.openvolley.app`, circa una volta al giorno. Può disattivarlo nelle
  impostazioni.
- **Pagina iniziale di app.openvolley.app:** se la apre nel browser di un
  computer, il suo browser ottiene da GitHub (`api.github.com`, USA) l'elenco
  delle versioni più recenti per proporre il download adatto. GitHub riceve il
  suo indirizzo IP.
- **GitHub e F-Droid:** se scarica da loro, valgono le loro informative sulla
  protezione dei dati.

## 13. Supporto e contatto

**Modulo di supporto nelle app:** trasmette al server tipo e ambito della
segnalazione, la sua descrizione, facoltativamente il suo indirizzo e-mail,
l'indirizzo della pagina e l'identificativo del browser. Il suo indirizzo
e-mail e l'inizio del messaggio vengono annotati nel registro del server
(sezione 14); la segnalazione può essere inoltrata per e-mail a
support@openvolley.app. Uso il suo indirizzo solo per risponderle. **Per
richieste sui suoi dati scriva direttamente a support@openvolley.app.**

**E-mail a support@openvolley.app:** conservo il suo messaggio per il tempo
necessario alla sua richiesta.

## 14. Registri e sicurezza sul server

- **Registri del server:** il server registra le richieste senza contenuti e
  **senza indirizzi IP** (stato, codice d'errore, identificativo della
  richiesta). Eccezioni: le segnalazioni del modulo di supporto e l'indirizzo
  del destinatario delle info della partita (sezioni 7 e 13). Le query lente
  della banca dati possono essere registrate con i loro valori. I registri
  vengono sovrascritti in base alla dimensione, di regola dopo alcuni giorni
  o poche settimane.
- **Cloudflare** tratta indirizzo IP, indirizzo richiesto e identificativo del
  browser di ogni richiesta e li conserva secondo le proprie regole.
- **Indirizzi IP solo nella memoria di lavoro:** per proteggersi dagli abusi
  il server limita richieste e connessioni per indirizzo IP, e il relay in
  diretta lo usa per riconoscere i dispositivi della stessa palestra. Tiene
  gli indirizzi IP solo nella memoria di lavoro e non li salva né li registra
  (salvo come hash pseudonimizzato di un'approvazione, sezione 7).
- **Registro delle modifiche:** per la tracciabilità il server annota chi ha
  modificato ruoli, approvato, chiuso o riaperto partite, aggiunto
  co-editori o modificato iscrizioni a un torneo, e quando. Le voci possono
  contenere indirizzi e-mail di co-editori e nomi di squadre di beach volley.
  Solo gli amministratori vedono questo registro.

## 15. Destinatari e responsabili del trattamento

Comunico dati personali solo ai fornitori di servizi di cui ho bisogno per
l'esercizio. Essi trattano i dati per mio conto.

| Fornitore | Compito | Paese |
|---|---|---|
| Hetzner Online GmbH | Server, banca dati, archiviazione dei file | Germania |
| Cloudflare, Inc. | Distribuzione dei siti, DNS, connessione sicura al server | USA (rete mondiale) |
| Migadu | Invio di e-mail (noreply@) e casella postale (support@) | Svizzera / Europa |
| Resend, Inc. | Invio delle info della partita per e-mail (solo questa funzione, se attivata) | USA |

**Importante riguardo a Cloudflare:** la connessione cifrata del suo
dispositivo termina presso Cloudflare; da lì prosegue cifrata fino al mio
server. Cloudflare può quindi tecnicamente vedere il contenuto delle
richieste, comprese liste squadra e date di nascita. Cloudflare può usare i
dati solo per fornire il proprio servizio.

**Sono responsabili in modo indipendente:** GitHub, Inc. (USA) per i download e
l'elenco delle versioni, F-Droid per il catalogo delle app, Swiss Volley per i
dati nel VolleyManager.

**Le copie di sicurezza** sono conservate cifrate sul mio server in Germania e
sui miei dispositivi in Svizzera; a tal fine nessun terzo riceve dati
(sezione 18).

**Comunicazione all'estero:** secondo il Consiglio federale, la Germania e
l'UE offrono una protezione adeguata dei dati. Per gli USA mi baso sullo
Swiss-U.S. Data Privacy Framework se il fornitore è certificato, altrimenti
sulle clausole contrattuali tipo nei contratti dei fornitori. Su richiesta
riceve una copia di queste garanzie.

## 16. Per quanto tempo conservo i dati

| Dati | Conservazione |
|---|---|
| Account e profilo | Finché non cancella l'account |
| Sessione | 30 giorni dall'ultimo utilizzo, al massimo 90 giorni |
| Link nelle e-mail | Validi 60 minuti o 24 ore, cancellati 7 giorni dopo |
| PIN di approvazione | Finché non lo rimuove o non cancella il suo account |
| Referti, eventi delle partite, firme, approvazioni, file dei referti | Come verbale ufficiale della partita, per il tempo necessario (stagione in corso e archivio). Cancellazione su richiesta nella misura in cui il verbale non necessita dei dati (sezione 19) |
| Squadre salvate, tornei di beach volley | Finché un gestore non li cancella, o su richiesta |
| Elenco degli arbitri, designazioni | Per il tempo necessario; cancellazione su richiesta |
| Registro delle modifiche | Per il tempo necessario alla tracciabilità; la cancellazione su richiesta viene esaminata |
| Copie di sicurezza caricate | 30 giorni |
| Registri dell'app caricati | Fino alla cancellazione del suo account |
| Registri del server | Sovrascritti in base alla dimensione (alcuni giorni o poche settimane) |
| Dati in diretta (server e modalità palestra) | Solo nella memoria di lavoro; sul server eliminati 24 ore dopo l'ultima attività |
| Copie di sicurezza del server | Fino a circa 6 mesi (sezione 18) |
| Dati sul suo dispositivo | Finché non li cancella; copie di sicurezza delle app desktop e Android 30 giorni |

## 17. Minorenni

Molte giocatrici e molti giocatori sono minorenni. I loro dati (nome, numero,
data di nascita) non vengono inseriti da loro stessi, ma da società,
responsabili di squadra, segnapunti od organizzatori. Questi devono essere
autorizzati a registrare i dati e devono informarne le giocatrici, i
giocatori e i loro genitori. La data di nascita serve al controllo
dell'idoneità e della categoria d'età nel referto ufficiale e non è mai
pubblica.

I genitori o altri rappresentanti legali possono esercitare i diritti della
sezione 19 per il proprio figlio.

## 18. Sicurezza e copie di sicurezza

- Connessioni cifrate (HTTPS) per tutti i siti e il server.
- Password, PIN e token di accesso sono salvati sul server solo come hash.
- Accesso secondo i ruoli; tablet solo con PIN; le partite chiuse sono in sola
  lettura.
- Limitazione dei tentativi di accesso e blocco dopo tentativi falliti.
- Copie di sicurezza: il server salva la banca dati ogni ora e i file ogni
  giorno, **in forma cifrata**. La chiave per decifrarle non si trova sul
  server. Le copie vengono trasferite ogni giorno sul mio dispositivo di
  archiviazione in Svizzera e vi sono conservate fino a 90 giorni, e in
  istantanee mensili **fino a circa 6 mesi**. I dati cancellati possono
  quindi restare fino a circa 6 mesi in queste copie cifrate; servono solo per
  un ripristino.
- Le copie di sicurezza dell'app desktop sono leggibili solo dal suo account
  utente e non contengono PIN.

Nessun sistema è perfettamente sicuro. Se trova una falla di sicurezza, la
segnali a support@openvolley.app.

## 19. I suoi diritti

Ha il diritto di:

- ottenere **informazioni** sui dati che tratto su di lei;
- far **rettificare** dati inesatti;
- far **cancellare** o rendere anonimi i dati;
- **opporsi** al trattamento;
- far **limitare** il trattamento, per esempio mentre si verifica una
  rettifica;
- **ricevere** i suoi dati in un formato comune o farli trasmettere (le app
  permettono anche di scaricare copie di sicurezza e referti);
- **revocare un consenso** in ogni momento (per esempio per la ricerca di
  aggiornamenti su Android).

Scriva a **support@openvolley.app**. Rispondo entro 30 giorni. Per non
comunicare dati alla persona sbagliata, posso chiedere una prova della sua
identità.

**Cancellazione nei referti ufficiali:** un referto chiuso è il verbale
ufficiale di una partita, a cui società, federazione e ufficiali di gara hanno
un interesse. Cancello o rendo anonimi i suoi dati in esso nella misura in cui
il verbale non ne ha bisogno, e le spiego cosa resta e perché.

**Reclamo:** può rivolgersi all'Incaricato federale della protezione dei dati
e della trasparenza (IFPDT, www.edoeb.admin.ch). Se risiede nell'UE o nello
SEE, anche all'autorità di protezione dei dati del suo paese.

## 20. Basi giuridiche (RGPD)

Se si applica il RGPD, mi baso su:

- **contratto** (art. 6 par. 1 lett. b RGPD): account, sincronizzazione,
  e-mail legate all'account, supporto, funzioni che utilizza;
- **interesse legittimo** (art. 6 par. 1 lett. f RGPD): verbali ufficiali
  delle partite corretti e verificabili per società, federazione e ufficiali
  di gara (liste squadra, date di nascita per il controllo dell'idoneità,
  firme, approvazioni), livescore per il pubblico, organizzazione di tornei,
  sicurezza e protezione dagli abusi, copie di sicurezza;
- **consenso** (art. 6 par. 1 lett. a RGPD): data di nascita facoltativa
  nell'account, ricerca di aggiornamenti dell'app Android installata
  direttamente.

Secondo la LPD svizzera tratto i dati solo per gli scopi indicati e nella
misura necessaria.

**Nessun obbligo di fornire dati:** non è obbligato né per legge né per
contratto a fornirmi dati. Senza indirizzo e-mail e password non posso però
aprire un account, e senza liste squadra non c'è referto.

## 21. Modifiche

Adeguo questa informativa quando cambiano le app o il diritto. Vale la
versione pubblicata su questa pagina, con la data indicata in alto.
