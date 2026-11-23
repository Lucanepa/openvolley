# Informativa sulla protezione dei dati

**OpenVolley e OpenBeach** · Versione 1.28 · Aggiornata al 23 novembre 2026

Questa informativa esiste in tedesco, inglese, francese e italiano. Fa fede
la versione inglese.

## In breve

- OpenVolley è un progetto open source privato e non commerciale. Non ci sono
  pubblicità, tracciamento, strumenti di analisi né cookie miei (la
  sezione 3 indica gli script che aggiunge Cloudflare).
- Le app funzionano offline. Le tue partite sono salvate sul tuo dispositivo,
  e nella banca dati del server solo dopo l'accesso. Affinché i tablet
  ricevano una partita in corso, le app browser e Android la fanno passare dal
  mio server anche senza accesso, solo nella memoria di lavoro.
- Lo strumento Global di OpenVolley non richiede un account. Le sue partite
  restano sul tuo dispositivo. Sul server si trovano solo un backup della
  partita e, alla fine, il referto in PDF, sotto un codice di backup casuale e
  senza account; vengono cancellati 180 giorni dopo l'ultima modifica. Se il
  segnapunti attiva «Salva nel cloud» per una partita (disattivato di
  default), questa è conservata anche leggibile sul server, senza PIN né
  immagini delle firme, fino a 180 giorni dopo l'ultimo salvataggio
  (sezione 7).
- «Nuova partita» nella versione svizzera (senza accesso) funziona allo
  stesso modo: nessun account, la partita sul tuo dispositivo, backup e PDF
  sotto il suo codice di backup, e niente squadre salvate, liste del club o
  elenco degli arbitri.
- Schermo live (facoltativo, in OpenVolley e OpenBeach): se i dispositivi
  segnapunti di un evento lo attivano, anche il punteggio di ognuna delle loro
  partite (nomi delle squadre, punti e set, nessun giocatore) va al server; è
  conservato solo in memoria ed è visibile a chiunque abbia il codice dello
  schermo live, e per le partite Global anche a chiunque su
  livescore.openvolley.app, a meno che sia disattivato (sezione 7).
- Un referto elettronico contiene dati di giocatrici e giocatori, staff e
  ufficiali di gara: nomi, numeri di maglia, numeri di licenza e firme. Una
  data di nascita figura nel referto di una partita solo se il segnapunti ne
  digita una (nello strumento Global l'organizzatrice o l'organizzatore
  sceglie cosa figura accanto a un nome). Sono
  pubblici solo i nomi delle squadre, il punteggio e i numeri di maglia; nel
  beach volley anche i nomi delle giocatrici e dei giocatori, nonché i nomi
  degli arbitri delle partite ufficiali. **Date di nascita, numeri di licenza
  e firme non sono mai pubblici.**
- Nessuna data di nascita è conservata altrove: né con gli account, né negli
  elenchi delle società, nelle squadre salvate, negli elenchi inviati in
  anticipo, nell'elenco degli arbitri o nelle designazioni. Quelle salvate
  prima del 19 novembre 2026 sono state cancellate, anche dai referti passati
  (sezione 16).
- L'app OpenVolley tiene un registro attività di ogni partita, senza PIN né
  password. Se hai effettuato l'accesso, viene caricato sul server. Ciò che
  clicchi o digiti resta sul tuo dispositivo, salvo un riassunto senza il
  testo digitato se includi la diagnostica in una richiesta di supporto
  (sezioni 5 e 13).
- Quando qualcosa va storto, le app, le pagine web e il server inviano una
  segnalazione di errore al mio server, anche senza accesso: cosa non ha
  funzionato e dove nel programma, i passi subito prima (mai ciò che hai
  digitato), l'app e la sua versione, il sistema operativo, il browser e le
  dimensioni dello schermo. Puoi disattivarla nelle opzioni (sezione 5).
- Il server si trova in Svizzera: lo noleggio da Infomaniak a Ginevra e lo
  gestisco io stesso. Cloudflare (USA) distribuisce i siti web e inoltra il
  traffico al server.
- Se l'invio è attivato, dopo una partita ufficiale il segnapunti, gli arbitri,
  le società delle due squadre e l'indirizzo di contatto inserito per ogni
  squadra ricevono il referto finale per e-mail (sezione 7).
- Il responsabile di una squadra può inviare in anticipo l'elenco di una
  partita. Il dispositivo del segnapunti lo conserva per la preparazione della
  partita; appena il segnapunti lo accetta, il server lo cancella (sezione
  10).
- I verbali delle partite (referti, eventi delle partite, file dei referti)
  sono conservati per la loro stagione e le due stagioni successive, poi
  cancellati (sezione 16).
- Puoi chiedere in ogni momento informazioni, rettifica o cancellazione:
  **support@openvolley.app**.

## 1. Chi è responsabile

Il titolare del trattamento è:

**Luca Canepa**, persona privata, Svizzera\
Indirizzo postale: vedi le [note legali](impressum.md)\
E-mail: support@openvolley.app

Gestisco OpenVolley come persona privata. Non ho nominato un consulente per la
protezione dei dati; non vi sono tenuto. Per tutte le domande sulla
protezione dei dati scrivi a support@openvolley.app.

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
  per funzionare nella memoria del tuo browser o dispositivo (localStorage e
  IndexedDB): i dati delle partite per l'uso offline, le tue impostazioni e,
  se hai effettuato l'accesso, un token di accesso.
- **Nessun tracciamento, nessuna pubblicità, nessuna analisi.** Non ci sono
  strumenti di analisi, invii di segnalazioni di errore a terzi (le segnalazioni di errore vanno
  solo al mio server, sezione 5), pubblicità,
  profilazione né decisioni individuali automatizzate. Non vendo dati.
- **Nessun contenuto di terzi.** Caratteri e codice dei programmi provengono
  dai nostri siti, non da server di terzi. Le eccezioni sono indicate
  espressamente (sezione 12 e gli script di Cloudflare qui sotto).
- **Script di Cloudflare.** Cloudflare, che distribuisce i siti
  (sezione 15), aggiunge alle pagine due piccoli script propri: in ogni pagina
  un controllo contro gli accessi automatizzati (rilevamento dei bot) e, su
  openvolley.app e get.openvolley.app, uno script che mostra gli indirizzi
  e-mail scritti nella pagina. Provengono dallo stesso indirizzo della pagina,
  non ti tracciano e non servono ad alcuna analisi. Il controllo dei bot può
  salvare il suo risultato in un cookie di Cloudflare (`cf_clearance`); è
  strettamente necessario per proteggere il servizio.
- **Prima offline.** Ciò che registri senza accedere è salvato solo sul tuo
  dispositivo. Per la trasmissione ai tablet, vedi la sezione 9.

## 4. Sito web e pagina di download

**openvolley.app** e **get.openvolley.app** sono pagine statiche; a parte gli
script di Cloudflare (sezione 3) non caricano alcuno script. L'unico modulo è il modulo di supporto su
openvolley.app/support (sezione 13). Quando le apri, Cloudflare tratta i dati
tecnicamente necessari: indirizzo IP, indirizzo richiesto, ora e
identificativo del browser. Il mio server non tiene un registro degli accessi
per get.openvolley.app.

I link a GitHub e F-Droid portano a servizi che sono essi stessi responsabili
del loro trattamento dei dati.

## 5. Le app di refertazione (browser, desktop, Android)

**Senza accesso**, l'app salva tutto solo sul tuo dispositivo: partite,
squadre, liste squadra (con numeri di licenza, e date di nascita dove il
segnapunti le ha digitate), set, eventi della partita, elenchi di ufficiali di
gara, impostazioni e i registri dell'app (vedi sotto). Le
partite restano salvate finché non le cancelli o non cancelli i dati dell'app.
Senza accesso, al mio server vanno solo le segnalazioni di errore (vedi
sotto).

**Trasmissione in diretta, anche senza accesso.** Appena una partita è
creata, le app browser e Android la inviano (squadre, liste squadra,
punteggio, eventi) al relay in diretta del mio server, affinché i tablet
dell'arbitro e della panchina la ricevano (sezione 9). Lì è tenuta solo nella
memoria di lavoro. L'app desktop usa invece il proprio relay nella rete locale.

**Con accesso**, l'app sincronizza le tue partite con il server (sezione 7).
Inoltre carica:

- **copie di sicurezza** di una partita (complete, con liste squadra e
  firme). Solo il tuo account può leggerle. Vengono cancellate dopo
  30 giorni;
- **registri dell'app** (messaggi tecnici dell'app; possono contenere nomi e
  numeri di partita). Solo il tuo account può leggerli. Vengono cancellati
  dopo 30 giorni, e con il tuo account;
- i **referti** come file (PDF e dati), vedi sezione 7.

**Registro attività (OpenVolley dalla versione 2.4.0).** Per la
tracciabilità del referto e per la diagnosi dei problemi, l'app annota ciò
che avviene sul dispositivo: punti e altri eventi della partita, annullamenti
e correzioni (cosa è stato modificato, quando e perché), set e stato della
partita, firme e approvazioni (solo la funzione e il fatto che sono
avvenute), osservazioni (solo la loro lunghezza), modifiche alle liste
squadra (solo il numero di maglia), esiti degli invii al server, errori
dell'app (messaggio e punto del programma), avvio, aggiornamento e chiusura
dell'app, nonché accesso e uscita. Ogni voce contiene un identificativo
casuale del dispositivo (creato dall'app, non legato all'hardware), la
versione dell'app, la piattaforma e, se hai effettuato l'accesso, il tuo
account. **Non vengono mai registrati** PIN, password, token di accesso,
immagini delle firme, date di nascita, indirizzi e-mail, numeri di telefono e
di licenza; se qualcuno modifica a mano un tale campo, il registro indica solo
che è stato modificato. Nel testo libero (messaggi di errore, valori delle
modifiche) le sequenze di sei o più cifre e i numeri accanto a parole come
«PIN», «codice» o «password» vengono oscurati. Il registro non contiene quindi
più dati personali del referto stesso (numeri di maglia, nomi degli ufficiali
di gara in una correzione). Puoi consultarlo nell'app e salvarlo come file
(CSV o JSON).

**Dove si trova il registro attività:** sul tuo dispositivo; nelle app
desktop e Android anche come file giornalieri nella cartella
`OpenVolley/logs` (desktop: nella tua cartella utente accanto alle copie di
sicurezza, Android: nella cartella propria dell'app, vedi sotto). Se hai effettuato
l'accesso, l'app lo carica sul mio server, comprese le voci create su questo
dispositivo senza accesso. Sul server le voci di una partita possono essere
lette dall'account che ha registrato la partita, dagli account che hanno
inserito il PIN della partita e dagli amministratori; le voci senza partita
sono visibili solo agli amministratori. Quando una partita viene cancellata
sul server, le sue voci vengono cancellate con essa. Per quanto tempo le voci
restano è indicato nella sezione 16; su richiesta le cancello prima
(sezione 19).

**Segnalazioni di errore (da novembre 2026).** Quando si verifica un errore,
l'app o la pagina web invia una segnalazione al mio server, con o senza
accesso: l'app di refertazione, le pagine per arbitro, panchina, livescore,
referto, lista squadra, dettatura, manager e TV, e OpenBeach. Una
segnalazione contiene il messaggio d'errore e il punto nel programma (nomi
dei file e numeri di riga), la schermata o la pagina aperta, gli ultimi
passi prima dell'errore (schermate aperte, i pulsanti toccati (con il loro
nome interno, non il testo), gli indirizzi del server chiamati e il loro
esito; mai ciò che hai digitato né il contenuto di un campo di inserimento),
l'app (OpenVolley o OpenBeach), lo strumento e la sua versione, il sistema
operativo e la sua versione, il browser o la vista web e la sua versione,
come gira l'app (scheda del browser, app web installata, app desktop o
mobile), il modello del dispositivo dove il sistema lo indica, le dimensioni
dello schermo e della finestra, la lingua e il fuso orario, se il
dispositivo era online, l'identificativo casuale del dispositivo (lo stesso
del registro attività), un identificativo casuale della visita,
l'identificativo esterno della partita aperta e, se hai effettuato
l'accesso, il tuo account. **Mai contenuti** sono PIN, password, token di
accesso, testo digitato, indirizzi e-mail, date di nascita, numeri di
telefono, immagini delle firme e il tuo indirizzo IP; il server rimuove di
nuovo questi valori, qualunque cosa invii un dispositivo. Il server registra
i propri errori nello stesso modo (la richiesta e il punto nel programma,
senza contenuti).
Solo gli amministratori con tutti i diritti vedono le segnalazioni, nel
manager; lì vedono anche nome, indirizzo e-mail, ruoli e società di un
account connesso, e l'apertura delle segnalazioni viene registrata nel
registro delle modifiche (sezione 14). Gli amministratori vengono informati
dei nuovi errori per e-mail, con i ruoli e le società degli account
interessati ma mai un nome o un indirizzo, e con una notifica push sul
telefono tramite un servizio di notifica sul mio computer (solo strumento,
versione, sistema operativo e messaggio d'errore). Le segnalazioni restano
90 giorni (sezione 16). Puoi disattivarle nelle opzioni (Supporto e
feedback: «Invia automaticamente le segnalazioni di errore»); le
segnalazioni già inviate restano fino alla scadenza, oppure le cancello su
richiesta (indica l'identificativo del dispositivo mostrato lì).

**Cronologia degli eventi (OpenVolley dalla versione 2.4.0).** Quando un
punto o un altro evento viene annullato o corretto, l'app annota l'evento
precedente (per una modifica anche quello nuovo) con motivo, ora,
identificativo del dispositivo, versione dell'app e account. Se l'evento era
già sul server, il server non lo cancella, ma lo contrassegna come annullato e
conserva la modifica, così lo svolgimento della partita resta tracciabile. La
cronologia degli eventi fa parte della partita e viene cancellata con essa.
Sul server la vedono solo gli amministratori.

**Registro d'uso: ciò che clicchi o digiti resta sul tuo dispositivo.** Per la
diagnosi dei problemi l'app registra sul dispositivo ciò che clicchi e digiti
(anche il testo nei campi di inserimento, per esempio nomi). Questo registro
non viene caricato da solo. Solo se includi la diagnostica in una richiesta di
supporto, la accompagna un riassunto delle ultime due ore circa, senza il
testo digitato (sezione 13). Puoi scaricarlo tu stesso (nelle impostazioni o a
fine partita nel file ZIP) e inviarlo per esempio al supporto. In OpenVolley
dalla versione 2.4.0 non registra alcun inserimento nei campi password e PIN
né i PIN mostrati sullo schermo, e viene cancellato dopo 30 giorni od oltre
50 000 voci.

**App desktop.** L'app desktop salva inoltre copie di sicurezza automatiche
delle partite nella tua cartella utente (Linux:
`~/.local/share/OpenVolley/backups`, Windows: `%APPDATA%\OpenVolley\backups`).
Contengono nomi (e date di nascita dove il segnapunti le ha digitate), ma
nessun PIN, e vengono cancellate dopo 30 giorni. Dalla versione 2.4.0 l'app
desktop di OpenVolley scrive inoltre un
file di registro tecnico (`desktop.log`) nella cartella `OpenVolley/logs`:
avvio e chiusura, verifiche e download degli aggiornamenti, link e download
aperti (indirizzo senza parametri, posizione di salvataggio), numero di
tablet collegati ed errori. Resta sul tuo dispositivo, non viene mai caricato
e non contiene PIN, token di accesso né password dell'hotspot. Si conservano
al massimo cinque file precedenti da 5 MB ciascuno.

**App Android.** L'app Android conserva le sue copie di sicurezza (cifrate
con i PIN della partita; una partita di prova non ha PIN), i referti in PDF e i file giornalieri del registro
attività nella propria cartella dell'app, che nessun'altra app può leggere e
che viene cancellata con la disinstallazione. Solo se scegli «Esporta in
Documenti» copia dei file nella cartella pubblica «Documenti»
(`Documents/OpenVolley`). **Queste copie restano dopo la disinstallazione
dell'app e, su Android 10 e versioni precedenti, possono essere lette anche da
altre app.** Cancellale tu stesso quando non ti servono più. Le versioni
fino alla 3.1.4 salvavano i file in «Documenti»; le versioni più recenti li
spostano nella cartella dell'app al primo avvio. Se hai attivato il backup Google
del dispositivo, Android può salvare anche i dati dell'app (con le liste
squadra) nel tuo account Google; valgono le condizioni di Google.

Su un dispositivo condiviso, esci dall'account dopo la partita. L'uscita
cancella dall'app il token di accesso, il tuo profilo e le tue società, le
partite del giorno, le squadre, gli elenchi e le liste delle licenze delle
società memorizzati temporaneamente, e gli indirizzi e-mail con cui gli
ufficiali hanno confermato su questo dispositivo; lo stesso avviene quando la
sessione scade o accede un altro account. Senza connessione, l'uscita chiude
anche la sessione sul server appena il dispositivo torna online. Gli
indirizzi degli ufficiali sono conservati al massimo 7 giorni. Non configurare
una passkey su un dispositivo condiviso (all'accesso spunta "Dispositivo
condiviso").

## 6. Account ed e-mail

Ti serve un account per sincronizzare partite, gestire squadre e tornei o
approvare risultati come ufficiale di gara. Gli account si aprono su
`manager.openvolley.app` e `manager-beach.openvolley.app`.

**Dati:** indirizzo e-mail, password (salvata solo come hash, mai in chiaro),
nome e cognome, paese, numero di licenza (il tuo numero di
licenza Swiss Volley, da 4 a 7 cifre; necessario per un nuovo account dal
23 novembre 2026, agli account aperti prima viene chiesto al prossimo
accesso), la lingua scelta all'apertura (per
le e-mail all'account), ruoli (per esempio
segnapunti, arbitro, gestore di competizione), le app per cui vale l'account
(indoor, beach), date di apertura, ultimo accesso e conferma dell'e-mail. I
dati inseriti alla registrazione sono conservati anche come copia presso
l'account.

**Scopo:** accesso, attivazione delle funzioni del tuo ruolo e
precompilazione dei tuoi dati nel referto (nome, paese, numero di licenza).

**Nessuna data di nascita:** la registrazione e il profilo non la chiedono, e
il server non ne conserva (dal 19 novembre 2026; le date di nascita inserite
prima sono state cancellate, sezione 16).

**I nuovi account** non hanno inizialmente alcun ruolo. Un amministratore li
abilita, oppure tu utilizzi un codice d'invito. Il sistema registra chi ha
utilizzato quale codice e quando.

**Che cosa fai (registrazione a OpenVolley, facoltativa):** alla registrazione
puoi indicare che cosa fai (segnapunti, arbitro, responsabile della squadra o
allenatore, responsabile della società) e per quale società e squadra. Questa
richiesta è conservata solo finché non è approvata o rifiutata, ed è visibile,
con il tuo nome e il tuo indirizzo e-mail, agli amministratori e ai
responsabili di quella società o squadra. Se è
approvata, il tuo account riceve esattamente quel ruolo, quella società o
quella squadra (da un amministratore, o dai responsabili della società o della
squadra per la propria società o squadra); il sistema registra chi ha deciso e
quando, ma in questa voce non il tuo nome né il tuo indirizzo.

**Società (OpenVolley):** un amministratore, o un codice d'invito, può
assegnare il tuo account a una o più società. Tu referti allora le partite
ufficiali in casa di queste società. Il sistema registra a quali società
appartiene il tuo account, chi l'ha assegnato e quando, finché la società o
l'assegnazione viene rimossa o tu elimini l'account. L'app di refertazione
conserva una copia delle tue società sul tuo dispositivo, per poter verificare
una partita anche offline; la copia viene eliminata quando ti disconnetti.

**Responsabili di società (OpenVolley):** un amministratore può nominare
account responsabili di una società. Degli account che refertano per la loro
società vedono nome, indirizzo e-mail, ruoli e data dell'assegnazione. Possono
creare codici d'invito per la loro società e togliere un account dalla
società; l'account stesso e i suoi ruoli restano. Una società può indicare un
**indirizzo di contatto** (inserito dagli amministratori o dai responsabili
della società); riceve i referti finali delle partite della società
(sezione 7).

I responsabili di società possono anche dare un link all'allenatore o al
responsabile di una squadra della società, che poi gestisce quella squadra
(sezione 10).

**Accesso:** dopo l'accesso il tuo browser salva un token di accesso. Sul
server si trova solo un hash di esso. Una sessione dura 30 giorni dall'ultimo
utilizzo, al massimo 90 giorni, e termina con l'uscita, il cambio della
password e la cancellazione dell'account. Per proteggersi dagli attacchi, il
server conta i tentativi falliti per indirizzo IP e per indirizzo e-mail nella
sua memoria di lavoro. La sua banca dati tiene inoltre, per un indirizzo e-mail
con tentativi falliti, quanti sono stati nelle ultime 24 ore, sotto un hash a
senso unico dell'indirizzo (non l'indirizzo stesso), e, per ogni account, fino
a 20 reti da cui è stato usato (un indirizzo IPv4, o la prima metà di un
indirizzo IPv6): un hash con chiave dell'indirizzo e-mail e della rete, che
senza la chiave segreta del server non dice nulla. Viene scritto quando vi
accedi con la tua password o una passkey, o vi apri un link di un'e-mail
dell'account. Dopo 100 tentativi falliti in 24 ore, da queste reti si
continua come di consueto, ogni altra può provare solo di tanto in tanto, e
l'account riceve un avviso per e-mail (una volta in quel periodo). Il numero
viene cancellato dopo le sue 24 ore, con una nuova password e con l'account;
una rete 60 giorni dopo il suo ultimo uso e con l'account.

**E-mail:** invio solo e-mail legate all'account: conferma dell'indirizzo
e-mail, link per reimpostare la password, avviso di cambio password, avviso
che qualcuno continua a provare ad accedere al tuo account (sopra), avviso
che un risultato è stato approvato con il tuo PIN di approvazione e avviso
che il tuo PIN è stato bloccato. Non contengono pixel di tracciamento né
immagini caricate da remoto. Un link di conferma vale 24 ore, un link di
reimpostazione 60 minuti.

**Referti per e-mail:** invio il referto finale di una partita ufficiale e
il referto della tua partita di prova come descritto nella sezione 7.

**Chi vede i dati del tuo account:** tu stesso e gli amministratori di
OpenVolley (io e le persone da me designate). Inoltre, nella misura in cui il
loro compito lo richiede:

- i responsabili di una società per cui fai il segnapunti o di cui gestisci
  una squadra: il tuo nome, indirizzo e-mail, ruoli e da quando appartieni
  alla società o gestisci la squadra;
- i responsabili della società o della squadra indicate alla registrazione
  (chi approva): il tuo nome, indirizzo e-mail, la data di registrazione e se
  il tuo indirizzo è confermato, finché la tua richiesta non è decisa;
- gli altri gestori di un torneo di beach volley che gestisci: il tuo
  indirizzo e-mail;
- i segnapunti che ricevono una lista squadra inviata da te in anticipo: il
  tuo nome come mittente (sezione 10);
- gli altri segnapunti di una partita ufficiale che tu referti già: il tuo
  nome, affinché sappiano che la partita è assegnata;
- i gestori di competizione dell'app: il nome dell'account che ha registrato
  ogni partita, nell'elenco dei referti.

**Cancellare l'account:** puoi cancellare il tuo account in qualsiasi momento
nell'app. Vengono cancellati account, profilo, sessioni, PIN di approvazione,
codici d'invito utilizzati, le tue copie di sicurezza e i registri caricati e
le tue voci del registro attività senza partita. **Restano** i documenti
ufficiali a cui altri hanno un interesse: i referti che hai registrato, le
approvazioni che hai dato (con il tuo nome come figura nel referto), le
squadre e i tornei salvati, le voci del registro delle modifiche
(sezione 14), nonché il registro attività e la cronologia degli eventi delle
partite (sezione 5). Il tuo account viene separato da queste voci. Puoi far
cancellare ciò che resta secondo la sezione 19, nella misura in cui il
referto non ne ha bisogno.

**Cancellazione da parte di un amministratore:** anche un amministratore può
cancellare il tuo account, quando lo chiedi (sezione 19) o quando un
nuovo account non viene abilitato (rifiutato). Vengono cancellati gli stessi
dati e restano gli stessi come quando lo cancelli tu.

## 7. Dati delle partite e referti

**Contenuto di una partita:** numero della partita, lega, palestra e località,
squadre (nome, nome breve, colore), liste squadra con numero di maglia, nome e
cognome, numero di licenza e indicazione libero o capitano, staff (funzione,
nome, numero di licenza), ufficiali di gara (arbitri, segnapunti, giudici di
linea con nome, paese e numero di licenza; arbitri con indirizzo e-mail
facoltativo), un indirizzo e-mail di contatto facoltativo per squadra, **firme** (immagini disegnate sul
dispositivo o su un telefono), sorteggio, svolgimento della partita con tutti gli eventi,
sostituzioni e sanzioni, risultati e correzioni successive, nonché le
**osservazioni** (il riquadro delle osservazioni del referto: ciò che scrive
il segnapunti e le righe che aggiunge l'app, per esempio per una sostituzione
obbligata o un libero che non può più giocare). Con la partita vengono
conservate anche le **osservazioni tecniche**: ciò che l'app annota su come è
stata registrata la partita (correzioni, una modifica della lista squadra dopo
il sorteggio, un set riaperto, firme cancellate o date di nuovo, una
sostituzione per infortunio con un sostituto regolare, un infortunio in
panchina) e ciò che il segnapunti aggiunge come tale. Non vengono stampate sul
referto.

**Numero di licenza o data di nascita:** nella versione svizzera accanto a un
nome figura il numero di licenza. Il segnapunti può digitarvi invece una data
di nascita; essa figura allora solo nel referto di quella partita. Nello
strumento Global l'organizzatrice o l'organizzatore del torneo sceglie cosa
figura accanto a un nome: la data di nascita, un numero d'identità o un testo.

**Dati sulla salute in una partita:** una sostituzione o un cambio del libero
perché una giocatrice o un giocatore è infortunato o malato, e un infortunio
annotato dal segnapunti, sono informazioni sulla salute (dati personali
degni di particolare protezione secondo la LPD, categoria particolare secondo
il RGPD). L'app registra l'evento con il suo motivo, come richiedono le
regole, e scrive nelle osservazioni solo le parole delle regole (per esempio
«#4 substituted, cannot continue playing»), mai una diagnosi. Le
osservazioni scritte dal segnapunti possono dire di più: scrivi solo ciò che
serve al verbale. Le osservazioni le vedono coloro che vedono tutto (tabella
qui sotto) e, durante la partita, il tablet dell'arbitro e chi ha il PIN
della partita, mai i tablet della panchina né il pubblico; figurano sul
referto e raggiungono così i suoi destinatari (qui sotto). Una sostituzione
per infortunio con un sostituto regolare e un infortunio in panchina sono
invece osservazioni tecniche: non figurano sul referto né sul tablet
dell'arbitro, restano con il verbale della partita e sono elencate nell'e-mail
del referto finale (qui sotto). Base giuridica:
sezione 20; conservate con la partita (sezione 16).

**Chi inserisce i dati:** il segnapunti nell'app, i responsabili di squadra
sulla pagina delle liste squadra (`roster.openvolley.app`) e nel sito di gestione (sezione 10), i gestori di
competizione tramite le squadre salvate (sezione 10) e le designazioni
ufficiali di Swiss Volley (sezione 11). Le giocatrici e i giocatori non
inseriscono essi stessi i propri dati. Un'Einsatzliste importata nella
preparazione della partita compila nomi, numeri di maglia e numeri di
licenza; le sue date di nascita non vengono riprese.

**Scopo:** un referto elettronico per le partite ufficiali: registrazione
durante la partita, verbale ufficiale della partita, controllo
dell'idoneità (numero di licenza), livescore.

**Chi vede cosa:**

| Chi | Cosa |
|---|---|
| L'account che ha registrato o chiuso la partita; gli amministratori | Tutto |
| Gli account che hanno inserito il PIN della partita (per esempio un tablet che riprende la partita) | Tutto, fino alla chiusura della partita |
| Tablet dell'arbitro con il PIN arbitro | Squadre, entrambe le liste squadra con nomi e numeri, punteggio, osservazioni (senza le osservazioni tecniche). **Nessuna** data di nascita, firma, ufficiale di gara o approvazione |
| Tablet della panchina con il PIN della sua squadra | La lista della propria squadra con nomi e numeri, i numeri di maglia dell'altra squadra, punteggio. **Nessuna** osservazione, data di nascita, firma, ufficiale di gara o approvazione |
| Tutti (pubblico) | Vedi sezione 8 |

Una volta approvata e chiusa, una partita non può più essere modificata da
nessuno, nemmeno dalla persona che l'ha registrata. Solo un amministratore
può riaprirla. Dalla chiusura il PIN della partita non apre più il verbale:
mostra solo ciò che è pubblico (sezione 8), e gli account che si sono aggiunti
con esso non possono più leggere la partita. Ogni ripristino di una partita
con il PIN della partita viene annotato nel registro delle modifiche. Chi ha
creato la partita e gli amministratori vedono gli account che si sono
aggiunti con il PIN della partita e possono rimuoverli.

**File dei referti:** alla fine della partita l'app carica il referto in PDF e
come file con i dati della partita. Può leggerlo solo l'account che l'ha
caricato (tramite `scoresheet.openvolley.app`), gli amministratori e i
responsabili competizione dell'app interessata (OpenVolley o OpenBeach),
che possono aprire il PDF nel manager. Ogni apertura viene annotata nel
registro con il loro account. Se l'account che l'ha caricato viene cancellato,
il file resta conservato come verbale della partita; solo gli amministratori e
i responsabili competizione possono ancora aprire il PDF.

**Referto finale per e-mail:** questa funzione è inizialmente spenta; la
accendono gli amministratori e i responsabili delle competizioni di
OpenVolley. Quando è accesa, il server invia il referto di una partita
ufficiale indoor chiusa, in PDF, a:

- l'account che ha chiuso la partita e l'account del segnapunti che ha
  approvato il risultato;
- gli arbitri che hanno approvato il risultato con il loro account o il cui
  indirizzo e-mail è stato inserito per la partita;
- l'indirizzo di contatto della società di ogni squadra (sezione 6), affinché
  la società possa inoltrare il referto agli allenatori;
- l'indirizzo di contatto inserito per ogni squadra nella configurazione della
  partita o in «Modifica info partita», come gli indirizzi degli arbitri.

Ogni indirizzo riceve una propria e-mail e non vede gli altri. Se una partita
viene riaperta e chiusa di nuovo, il referto corretto viene inviato ancora una
volta ai destinatari. Vengono salvati solo il momento dell'invio e il numero
di indirizzi, non gli indirizzi. Le partite chiuse prima dell'accensione non
vengono inviate. L'indirizzo e-mail di un arbitro o di una squadra è
facoltativo, fa parte della partita e non è mai pubblico; lo vede solo chi può leggere tutta la
partita (tabella sopra). L'e-mail elenca nel testo anche le osservazioni
tecniche della partita (sopra); non figurano nel PDF. L'invio avviene tramite
Migadu (sezione 15).

**Referto di una partita di prova:** se alla fine di una partita di prova
approvi il risultato da connesso, l'app invia il referto in PDF all'indirizzo
e-mail del tuo account, e a nessun altro. Il server non lo conserva; sul tuo
dispositivo la partita di prova viene cancellata alla chiusura.

**Strumento Global (senza account):** nello strumento Global di OpenVolley
(scelto all'avvio dell'app, modificabile nelle Opzioni finché non c'è una
partita sul dispositivo) registri le partite di un torneo qualsiasi senza
account. Le rose, gli ufficiali di gara e le partite che digiti o carichi da un
file Excel o CSV restano sul tuo dispositivo; l'app legge il file sul
dispositivo e non lo carica. Una partita Global non compare mai nei record di
partita, squadra o giocatore della lega, né nel manager né nelle
visualizzazioni pubbliche della lega; solo con «Salva nel cloud» (sotto) è
conservata sul server, in una tabella separata tutta sua. Per ogni partita sul
server si
trovano due file, senza account: il backup della partita (il contenuto di un
file di backup: squadre, rose con nomi, numeri di maglia e date di nascita,
ufficiali di gara, firme, andamento della partita) e, una volta approvata la
partita, il referto in PDF. Si trovano sotto un codice di backup casuale
(128 bit) che l'app crea per la partita e mostra nella preparazione della
partita. Il codice è l'unico accesso ai file: non esistono né un elenco né una
ricerca. Il backup è cifrato come ogni file di backup dell'app (senza i PIN):
si apre solo con il PIN arbitro della partita o con la chiave di recupero
della federazione, che questa conserva offline. Chi conosce il codice e questo
PIN può ripristinare la partita; conservali quindi come una password. Un
nuovo backup sostituisce il precedente. I file vengono
cancellati 180 giorni dopo l'ultima modifica; i backup del server (sezione 18)
ne conservano ancora una copia per un certo tempo. Se per il momento il server
rifiuta l'ultimo backup e il PDF (la quota giornaliera della tua rete è
esaurita, il server è sovraccarico, nessuna connessione), restano sul tuo
dispositivo e vengono inviati di nuovo più tardi, al massimo per 7 giorni;
lo stesso vale per l'ultima copia di «Salva nel cloud» (sotto). L'organizzatrice o
l'organizzatore del torneo è responsabile di poter registrare i dati e di
informare le giocatrici, i giocatori e i loro genitori (sezione 17).

**Nuova partita senza account (versione svizzera):** senza accesso, «Nuova
partita» avvia una partita nel formato svizzero senza account. È trattata come
una partita Global: resta sul tuo dispositivo, non è mai nei dati di partite,
squadre o giocatori della lega, e il suo backup e il referto approvato in PDF
sono salvati allo stesso modo sotto un codice di backup casuale (cifrati,
cancellati 180 giorni dopo l'ultima modifica). Può usare i dati pubblici del
calendario di Swiss Volley (squadre, palestra, lega, numero della partita,
nomi degli arbitri, senza date di nascita) e un'Einsatzliste letta sul
dispositivo. Le squadre salvate, le liste delle licenze dei club, i roster
inviati dalle squadre e l'elenco degli arbitri non sono disponibili, anche se
qualcuno accede più tardi sul dispositivo.

**Salva nel cloud (strumento Global, facoltativo):** nella preparazione della
partita il segnapunti può attivare «Salva nel cloud» per una partita Global;
di default è disattivato. Allora la partita, oltre al backup e al PDF di cui
sopra, è conservata anche leggibile (non cifrata) nel database del server,
senza account: il contenuto del referto (squadre, rose con nomi, numeri di
maglia e date di nascita, staff delle squadre, ufficiali di gara, andamento
della partita, set, osservazioni), senza i PIN, le immagini delle firme, il
codice di backup e il codice torneo; un riepilogo (nomi, nomi brevi e colori
delle squadre, set e punti, stato, palestra, lega, orario previsto, numero
della partita); e, una volta approvata la partita, il referto in PDF, sul
quale figurano le firme e le date di nascita. La partita viene trovata tramite
un hash del suo codice di backup e protetta da un hash del suo PIN arbitro; il
server non conserva né il codice né il PIN. A scelta:

- **Link di condivisione:** un link in sola lettura con un token casuale, che
  il segnapunti attiva e disattiva. Chiunque abbia il link vede il risultato,
  i set e il referto in PDF su livescore.openvolley.app.
- **Codice torneo:** un codice di 10 caratteri, inserito sui dispositivi
  segnapunti di un torneo. Chiunque abbia il codice vede l'elenco di tutte le
  partite salvate con esso, con i loro riepiloghi e PDF, su
  livescore.openvolley.app. Il server conserva il codice solo come hash.
- **Un altro dispositivo:** per continuare lì, ripristini la partita con il
  codice di backup e il PIN arbitro, come sopra.

La copia leggibile, il link di condivisione e il codice torneo vengono
cancellati 180 giorni dopo l'ultimo salvataggio, o subito quando il
segnapunti sceglie «Elimina dal cloud»; i backup del server (sezione 18) ne
conservano ancora una copia per un certo tempo. Senza «Salva nel cloud» niente
di tutto ciò viene conservato. Anche qui l'organizzatrice o l'organizzatore
del torneo è responsabile di poter registrare i dati e di informare le
giocatrici, i giocatori e i loro genitori (sezione 17).

**Schermo live per TV (facoltativo, qualsiasi partita, anche OpenBeach):** i
dispositivi segnapunti di un evento possono attivare uno schermo live con un
codice comune (Opzioni, Schermo live), per partite di campionato, di prova,
semplici e Global allo stesso modo. Finché è attivo, ogni aggiornamento live
delle loro partite invia al mio server anche il codice, con un riepilogo del
punteggio: i nomi delle squadre, i nomi brevi e i colori, i punti, i set vinti
e i punti dei set conclusi, quale squadra è al servizio, lo stato della
partita (per esempio time-out, pausa tra i set, terminata), la palestra o il
campo e l'orario previsto. Un dispositivo segnapunti che passa da un relay di
palestra o dall'app desktop invia lo stesso riepilogo tramite questi.
Giocatori, staff delle squadre, ufficiali di gara, formazioni, sanzioni,
osservazioni, firme e PIN non vengono inviati; in OpenBeach, però, il nome di
una squadra è di solito quello delle sue giocatrici o dei suoi giocatori, e
allora compare sullo schermo. Il riepilogo è conservato solo nella memoria del
server, mai in un database o in un file, e viene rimosso 45 minuti dopo la
fine della partita, dopo 3 ore senza aggiornamenti (15 minuti per un riepilogo
arrivato una sola volta e non tramite il relay) o al riavvio del server.
Chiunque conosca il codice può vedere i riepiloghi delle sue partite su
openvolley.app/tv e livescore.openvolley.app o leggerli tramite l'interfaccia
del server; un relay di palestra li mostra anche nella sua rete. Gli schermi
non sono un documento ufficiale: un riepilogo che arriva al server solo
tramite l'app desktop o un relay di palestra, da OpenBeach fino alla 3.1.1 o
da OpenVolley fino alla 26.11.5, può essere sovrascritto da chi conosce il
codice e l'identificativo pubblico della partita. Un
dispositivo segnapunti con un codice dello schermo live elenca inoltre i
riepiloghi delle sue partite Global su livescore.openvolley.app, per chiunque
e senza il codice, a meno che «Mostra le partite Global su
livescore.openvolley.app» sia disattivato su di esso in Opzioni, Schermo live
(di default è attivo). Un codice con un riepilogo in questa lista mostra solo
i suoi riepiloghi elencati, anche sui TV; una partita che non deve essere
elencata ha bisogno di un codice proprio. Le partite di campionato sono
comunque nel livescore; le partite di prova e semplici non vi compaiono mai.
Disattiva lo schermo live nelle Opzioni per interrompere l'invio.

**Approvazione con PIN:** gli ufficiali di gara possono confermare il
risultato, oltre che con la firma, con un PIN di approvazione personale.
Vengono salvati: il PIN come hash crittografico (mai in chiaro), i tentativi
falliti e i blocchi; per ogni approvazione la partita, la funzione (1° o
2° arbitro, segnapunti), il tuo account, il tuo nome al momento
dell'approvazione, l'ora, il risultato approvato e un hash pseudonimizzato
dell'indirizzo IP e del dispositivo (per riconoscere abusi). Le approvazioni
fanno parte del verbale della partita. Tu vedi le tue approvazioni; anche il
segnapunti della partita e gli amministratori le vedono.

**Firmare sul telefono (OpenVolley dalla versione 2.4.0):** invece che sul
dispositivo del segnapunti, una persona può firmare sul proprio telefono. Il
dispositivo mostra un codice QR con un link al mio server
(`backend.openvolley.app`) o, in modalità palestra, al portatile nella rete
locale. Il link vale 10 minuti e per una sola firma. Sul telefono non servono
né account né app. La pagina mostra numero della partita, squadre, data,
funzione e, se noto, il nome della persona che firma. Il telefono invia solo i
tratti della firma (nessuna immagine). Il server o il portatile tiene questi
dati solo nella memoria di lavoro, passa la firma al dispositivo del
segnapunti e la elimina al più tardi 5 minuti dopo la firma; nella banca dati
non viene salvato nulla. Il telefono non salva nulla: né cookie né memoria
locale; il link resta solo nella scheda del browser durante la sessione e
viene cancellato alla fine. Solo il dispositivo del segnapunti ne ricava
l'immagine della firma. Come una firma disegnata lì, fa parte della partita,
con l'annotazione che è stata fatta su un telefono (via e ora). Tramite il
server occorre che il segnapunti abbia effettuato l'accesso con un ruolo di
segnapunti o di arbitro.

**Invio delle info della partita per e-mail:** un segnapunti che ha
effettuato l'accesso può farsi inviare le info di una partita che ha
registrato o che modifica (numero della partita, squadre, data e luogo, nessun
PIN) all'indirizzo e-mail confermato del proprio account; l'app lo fa quando
crea una partita. Non si può inserire nessun altro indirizzo. Per l'invio
viene utilizzato il servizio Resend (USA) (sezione 15).

**Invio del PIN della partita per e-mail:** subito dopo la creazione di una
nuova partita ufficiale, l'app mostra una volta il suo PIN della partita. Un
segnapunti che ha effettuato l'accesso può allora farsi inviare il PIN della
partita all'indirizzo e-mail confermato del proprio account, con numero della
partita, squadre, lega, data e ora. Non si invia nulla senza la sua
richiesta, non si può inserire nessun altro indirizzo e il server invia il
PIN solo se corrisponde a quello registrato per la partita. Il suo registro
non contiene né il PIN né l'indirizzo. Per l'invio viene utilizzato il
servizio Resend (USA) (sezione 15). L'app può anche aprire l'app e-mail del
dispositivo con il PIN, per qualsiasi indirizzo; quel messaggio lo invia l'app
e-mail e non passa dal mio server.

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
- **Tornei di beach volley pubblici** (sezione 10): squadre, nomi, cognomi e
  paesi delle giocatrici e dei giocatori, teste di serie, classifica,
  calendario, campi.

Questi dati sono ottenibili anche tramite l'interfaccia di programmazione del
server (`backend.openvolley.app`). Qualsiasi sito web può mostrare il livescore
di una partita, o le partite del giorno di una società, con il widget
livescore (anche come `<iframe>`); mostra gli stessi dati, senza nomi di
giocatrici e giocatori.

**Mai pubblici:** date di nascita, numeri di licenza, firme, approvazioni,
indirizzi e-mail e PIN. Le liste squadra con i nomi sono visibili solo a chi
conosce il PIN della partita o, per una partita Global salvata nel cloud, il
suo link di condivisione o codice torneo (sezione 7).

## 9. Tablet e modalità palestra (LAN)

**I tablet di arbitro e panchina** (`referee.`, `bench.`,
`referee-beach.openvolley.app`) si collegano alla partita con un PIN.
Il tablet dell'arbitro riceve entrambe le liste squadra con nomi e numeri, il
punteggio e le osservazioni; un tablet della panchina la lista della propria
squadra e solo i numeri di maglia dell'altra. Nessuno riceve date di nascita,
firme o dati sugli ufficiali di gara. Il tablet dell'arbitro
salva il PIN e il numero della partita nel browser; cancella i dati del
browser se il tablet è usato da più persone.

**Tramite il server (relay cloud):** i dati in diretta passano dal mio server.
Li tiene solo nella memoria di lavoro e li elimina 24 ore dopo l'ultima
attività. Ciò vale anche senza accesso.

**Modalità palestra (LAN):** l'app desktop può servire i tablet direttamente
nella rete locale della palestra, anche tramite un hotspot Wi-Fi proprio del
portatile. I dati restano allora nella rete locale e solo nella memoria di
lavoro. Nome e password dell'hotspot sono generati a caso sul tuo dispositivo
a ogni avvio. Solo la sincronizzazione con il server lascia la rete locale, e
solo se il segnapunti ha effettuato l'accesso.

**Tabellone LED (LedBox):** un tabellone in palestra può riprendere il
punteggio. Riceve solo nomi delle squadre, punteggio e risultati dei set,
nessun dato di giocatrici o giocatori.

## 10. Siti di gestione: squadre salvate, elenchi delle squadre e tornei di beach volley

Su `manager.openvolley.app` e `manager-beach.openvolley.app` i gestori di
competizione possono preparare squadre e tornei.

**Squadre salvate:** nome della squadra, società, giocatrici e giocatori con
numero, nome e cognome, numero di licenza, libero/capitano e (beach) paese;
staff con funzione, nome e numero di licenza; nessuna data di nascita.
Visibili ai gestori di competizione e agli amministratori dello sport
corrispondente. In OpenVolley un account segnapunti vede solo le squadre
salvate delle proprie partite della stagione in corso (le squadre delle sue
società e i loro avversari, e le partite che ha registrato o che modifica);
un account senza società solo poco prima della partita e per poche partite a
settimana, ognuna annotata nel registro delle modifiche. Le app di
refertazione memorizzano temporaneamente queste squadre e le cancellano
all'uscita.

**Completate dalle partite ufficiali (OpenVolley):** dopo il sorteggio di una
partita ufficiale indoor (mai una partita di prova o Easy), il server aggiunge
tutte le persone della lista di ogni squadra alla squadra salvata di quella
squadra per la stagione: le giocatrici e i giocatori con nome e cognome,
numero di maglia e numero di licenza, e gli ufficiali di squadra (allenatori,
fisioterapista, medico) con funzione, nome e cognome e numero di licenza. Chi
vi figura già (lo stesso numero di licenza, altrimenti lo stesso nome)
mantiene la sua voce; l'ultima partita ufficiale della squadra stabilisce i
numeri di maglia delle giocatrici e dei giocatori e le funzioni degli
ufficiali di squadra, e una giocatrice o un giocatore della squadra salvata
che aveva quel numero lo perde. Nessuno viene rimosso, e le indicazioni libero
e capitano della squadra salvata restano. Solo le giocatrici e i giocatori e
gli allenatori (allenatore, assistente allenatore 1 e assistente allenatore 2)
con un numero di licenza vengono aggiunti anche agli elenchi delle licenze
della società (sotto), le giocatrici e i giocatori all'elenco dei giocatori,
gli allenatori all'elenco degli allenatori, se gli elenchi della società non
hanno ancora quel numero di licenza; un fisioterapista o un medico resta solo
nella squadra salvata.

**Responsabili di squadra (OpenVolley):** i responsabili di una società
possono dare un link all'allenatore o al responsabile di una squadra della
società; chi lo apre ed effettua l'accesso gestisce quella squadra. Il server
salva quale account gestisce quale squadra, chi l'ha aggiunto e quando. Un
responsabile di squadra modifica la squadra salvata e può inviare in anticipo
l'elenco di ogni partita della squadra: giocatrici e giocatori con numero,
nome e cognome, numero di licenza e libero/capitano, e lo staff con
funzione, nome e numero di licenza; nessuna data di nascita. Se lo
desiderano, l'allenatore e il capitano possono firmare questo elenco in
anticipo; le firme vengono salvate con esso come immagini.

**Elenchi inviati in anticipo:** visibili ai responsabili della squadra, ai
responsabili della sua società e agli amministratori, nonché agli account con
il ruolo di segnapunti o di gestore di competizione di OpenVolley. I
dispositivi dei segnapunti scaricano gli elenchi delle prossime partite in
casa delle loro società, affinché la preparazione della partita funzioni senza
internet. Quando il segnapunti accetta un elenco nella preparazione della
partita, esso diventa parte della partita (sezione 7) e il server cancella
subito giocatrici e giocatori, staff e firme; conserva solo il fatto che
l'elenco è stato accettato, quando e da quale account. Un elenco che nessuno
accetta viene cancellato 14 giorni dopo la partita. Su un dispositivo di
refertazione la copia viene cancellata appena il server sa che è stato
accettato, all'uscita e al più tardi 36 ore dopo la partita.

**Elenchi delle licenze delle società (OpenVolley):** i responsabili di una
società possono caricare gli elenchi di giocatrici e giocatori, segnapunti e
allenatori della società dall'amministrazione della società di VolleyManager.
Il file viene letto nel browser: di ogni persona vengono conservati solo
numero di licenza, cognome, nome e sesso; la colonna della data di nascita non
viene letta, e nient'altro del file viene inviato al server. Gli elenchi sono
visibili ai responsabili della società e agli amministratori. Un responsabile
di squadra della società vede le giocatrici e i giocatori del sesso della sua
squadra e trova gli ufficiali di squadra (un allenatore può essere qualsiasi
persona degli elenchi della società) con una ricerca per nome che mostra poche
persone alla volta. I dispositivi dei segnapunti della società scaricano gli
elenchi, affinché la preparazione della partita possa aggiungere giocatori e
ufficiali di squadra senza internet. Il sesso serve a non
iscrivere giocatrici o giocatori in una squadra dell'altro sesso; per gli
ufficiali di squadra non viene controllato. Ogni caricamento sostituisce le
persone del caricamento precedente di quell'elenco; gli elenchi vengono
cancellati con la società, e quelli delle stagioni passate ogni giorno. Gli elenchi possono contenere anche persone che un
responsabile di squadra o di società ha aggiunto a mano dalla rosa di una
squadra, e le giocatrici, i giocatori e gli allenatori della lista di una
partita ufficiale (sopra), solo con numero di licenza, nomi e sesso; un caricamento le mantiene, e vengono cancellate con il loro elenco o con la
società. Su un dispositivo del segnapunti ogni download sostituisce la copia,
che viene cancellata all'uscita dall'account.

**API delle società (OpenVolley):** i responsabili di una società possono
creare token API per il software o il sito web della società (per esempio la
gestione dei soci). Un token appartiene a quella società (o a una delle sue
squadre), agisce con i diritti della persona che l'ha creato e smette di
funzionare quando viene revocato, scade o quella persona non gestisce più la
società. Con esso il software della società legge e, se il token lo consente,
scrive le squadre della società, gli elenchi inviati in anticipo per le sue
partite, le sue squadre salvate e le sue liste delle licenze, con i dati
descritti sopra (nomi, numeri di maglia, numeri di licenza), e le partite della
società come le mostra l'interfaccia pubblica (sezione 8). Nomi e numeri di
licenza li legge solo un token che può anche scriverli, e
un tale token richiede la password della persona responsabile. Il server conserva
del token solo un'impronta, il nome, i diritti, la squadra, la scadenza e
l'ultimo uso; il registro delle modifiche indica chi l'ha creato o revocato e
ogni modifica fatta con esso e ogni lettura di questi dati personali. Di ciò che il software della società fa con i
dati letti risponde la società.

**Tornei di beach volley:** titolo, luogo, date, squadre con nomi, cognomi,
numeri di licenza e paesi delle giocatrici e dei giocatori, calendario,
risultati, nomi di arbitri e segnapunti. Se un torneo è contrassegnato come
**pubblico**, la pagina pubblica del torneo mostra squadre, nomi e paesi, mai
numeri di licenza o date di nascita.

**Scopo:** riutilizzare le liste squadra, preparare in anticipo l'elenco di una partita, aggiungere a un
elenco giocatrici, giocatori e ufficiali di squadra della società e confrontare il sesso di giocatrici e
giocatori con quello della squadra, organizzare tornei, abbinare giocatrici e giocatori tramite il numero
di licenza durante l'importazione, compilare i numeri di maglia per la prossima partita.

Questi dati restano salvati finché un gestore non li cancella, anche se
l'account che li ha creati viene cancellato.

## 11. Dati sugli arbitri

**Designazioni di Swiss Volley:** ogni giorno il server riprende le
designazioni ufficiali dal VolleyManager di Swiss Volley, per il periodo da
ieri a 14 giorni in avanti: squadre, palestra e indirizzo, lega, 1° e
2° arbitro con i loro nomi, giudici di linea, convocazioni. A tal fine il
server usa un account VolleyManager. Scopo: caricare le partite ufficiali con
gli ufficiali di gara corretti. I nomi sono pubblici (sezione 8).
VolleyManager invia anche le date di nascita degli arbitri; il server non le
legge e non le conserva (dal 19 novembre 2026; quelle conservate prima sono
state cancellate). Le designazioni sono conservate come i verbali delle
partite (sezione 16).

**Numeri di licenza degli arbitri:** dal 20 novembre 2026 il server conserva
anche il numero di licenza (il numero di Swiss Volley) che VolleyManager
invia per il 1° e il 2° arbitro. Questi numeri non sono pubblici: solo gli
amministratori e gli account che refertano partite indoor li vedono, affinché
l'app di refertazione li inserisca accanto agli arbitri quando carica una
partita ufficiale. Sono cancellati con le designazioni (la stagione della
partita e le 2 stagioni successive, sezione 16), o prima su richiesta,
insieme al nome dell'arbitro (sezione 19). Una volta in un referto, fanno
parte del verbale della partita (sezione 7).

**Elenco degli arbitri:** un elenco comune con nome e cognome, paese e sport,
affinché il segnapunti non debba inserire ogni volta gli ufficiali di gara;
nessuna data di nascita (quelle conservate prima del 19 novembre 2026 sono
state cancellate). Gli account che refertano possono aggiungere voci; gli
amministratori possono modificarle e cancellarle. Solo gli amministratori e gli account che
refertano vedono l'elenco, per inserire gli ufficiali di gara di una partita
ufficiale; non è pubblico, e le partite di prova e le partite Easy non lo
mostrano.

Se non desideri figurare nell'elenco, scrivi a support@openvolley.app.

## 12. Download e aggiornamenti

- **App desktop:** 60 secondi dopo l'avvio, poi ogni 6 ore, all'accesso e su
  richiesta controlla se esiste una nuova versione, mai durante una partita
  in corso. Interroga `get.openvolley.app`, in alternativa GitHub. Viene
  trasmessa solo la richiesta usuale (indirizzo IP, identificativo del
  programma).
- **App Android da F-Droid:** l'app non cerca aggiornamenti da sola; lo fa la
  tua app F-Droid.
- **App Android installata direttamente:** l'app chiede una volta se deve
  cercare aggiornamenti (predefinito: no). Solo se acconsenti interroga
  `get.openvolley.app`, circa una volta al giorno. Puoi disattivarlo nelle
  impostazioni.
- **Pagina iniziale di app.openvolley.app:** se la apri nel browser di un
  computer, il tuo browser ottiene da GitHub (`api.github.com`, USA) l'elenco
  delle versioni più recenti per proporre il download adatto. GitHub riceve il
  tuo indirizzo IP.
- **GitHub e F-Droid:** se scarichi da loro, valgono le loro informative sulla
  protezione dei dati.

## 13. Supporto e contatto

**Modulo di supporto (nelle app e su openvolley.app/support):** trasmette al
mio server il tuo indirizzo e-mail, tipo e ambito della richiesta, il tuo
messaggio e, se li aggiungi, fino a cinque allegati (per esempio screenshot o
file di backup), insieme alla lingua, all'indirizzo della pagina senza
parametri, all'identificativo del browser, all'ora, alla piattaforma («web»
dal sito) e, nelle app, alla versione dell'app.

**I dati diagnostici** vengono inviati solo se «Includi la diagnostica» è
spuntato. Per una richiesta di supporto (segnalazione di errore o domanda) la
casella è già spuntata, per feedback e suggerimenti no; puoi togliere la spunta
prima dell'invio. «Mostra cosa viene inviato» ti mostra prima esattamente il
testo che viene inviato. L'app lo allega alla richiesta come file di testo (al
massimo 2 MB). Contiene:

- dati tecnici: app e versione, piattaforma, sistema operativo,
  identificativo del browser, dimensioni dello schermo e della finestra,
  lingua, ora e fuso orario, stato online e della connessione, dati non
  ancora trasmessi e gli ultimi errori di trasmissione, memoria occupata,
  l'identificativo casuale del dispositivo e, se hai effettuato l'accesso,
  l'identificativo del tuo account;
- lo stato della partita aperta (o dell'ultima aperta): numero della
  partita, squadre, stato, set e punteggio, formazioni (numeri di maglia),
  time-out e sostituzioni, gli ultimi 30 eventi della partita e se il server
  ha chiuso la partita o l'ha affidata a un altro dispositivo;
- la cronologia delle ultime due ore circa (almeno dall'ultimo avvio
  dell'app) dal registro attività e dal registro d'uso (sezione 5): ciò che
  hai toccato (con la sua etichetta, che può contenere nomi di squadre o di
  persone), i tasti, le schermate aperte, in quale campo hai digitato quanti
  caratteri (non il testo), i punti e gli altri eventi della partita, le
  correzioni, le trasmissioni e l'avvio, la chiusura e il passaggio in
  background dell'app;
- gli ultimi messaggi d'errore e avvisi dell'app con il punto del programma.

**Non sono mai inclusi** password, PIN, token di accesso, firme, indirizzi
e-mail, numeri di telefono e il testo digitato nei campi: l'app toglie questi
dati da tutto il testo prima dell'invio. Nelle viste di arbitro, panchina e
livescore il file contiene solo i dati tecnici, lo stato della connessione e
i messaggi d'errore. Se l'invio non riesce, «Scarica la diagnostica» salva il
file, così puoi allegarlo tu stesso alla tua e-mail. Le versioni meno recenti
dell'app inviano solo i dati tecnici, il numero della partita e gli ultimi
messaggi d'errore. Il sito web non invia dati diagnostici.

Il server inoltra la richiesta come un'unica e-mail a support@openvolley.app,
con il tuo indirizzo come indirizzo di risposta. Non ne conserva nulla, salvo
una riga di registro con tipo, ambito e una forma abbreviata del tuo
indirizzo e-mail (sezione 14). La casella postale è presso Migadu
(sezione 15). Il mio sistema di ticket (support.openvolley.app), che gestisco
io stesso sul mio server presso Infomaniak in Svizzera, la legge, così posso risponderti e
seguire la tua richiesta. Uso il tuo indirizzo solo per risponderti. **Per
richieste sui tuoi dati scrivi direttamente a support@openvolley.app.**

**E-mail a support@openvolley.app:** viene trattata allo stesso modo, nella
casella postale e nel sistema di ticket.

**Conservazione:** conservo le richieste di supporto (casella postale e
sistema di ticket, con gli allegati e i dati diagnostici) per 2 anni dopo
l'ultimo messaggio, per poter ritrovare le risposte precedenti; prima su
richiesta.

## 14. Registri e sicurezza sul server

- **Registri del server:** il server registra le richieste senza contenuti e
  **senza indirizzi IP** (stato, codice d'errore, identificativo della
  richiesta). Eccezione: una richiesta di supporto viene registrata con una
  forma abbreviata del tuo indirizzo e-mail (sezione 13). Le query lente o
  non riuscite della banca dati vengono registrate senza i loro valori. I
  registri vengono sovrascritti in base alla dimensione (al massimo 10 file
  da 20 MB per servizio), di regola dopo alcuni giorni o poche settimane.
- **Segnalazioni di errore:** gli errori del server stesso vengono salvati
  come segnalazioni di errore (sezione 5), senza contenuti e senza indirizzi
  IP. L'indirizzo IP di un dispositivo che invia segnalazioni viene usato
  solo in memoria, per limitarne il numero.
- **Cloudflare** tratta indirizzo IP, indirizzo richiesto e identificativo del
  browser di ogni richiesta e li conserva secondo le proprie regole.
- **Indirizzi IP solo nella memoria di lavoro:** per proteggersi dagli abusi
  il server limita richieste e connessioni per indirizzo IP, e il relay in
  diretta lo usa per riconoscere i dispositivi della stessa palestra. Tiene
  gli indirizzi IP solo nella memoria di lavoro e non li salva né li registra
  (salvo come hash pseudonimizzato di un'approvazione, sezione 7, e come hash
  con chiave delle reti da cui un account è stato usato, sezione 6).
- **Registro delle modifiche:** per la tracciabilità il server annota chi ha
  modificato ruoli, approvato, chiuso o riaperto partite, aggiunto
  co-editori o modificato iscrizioni a un torneo, e quando. Le voci possono
  contenere indirizzi e-mail di co-editori e nomi di squadre di beach volley.
  Solo gli amministratori vedono questo registro.
- **Società e referti per e-mail:** il registro delle modifiche annota anche
  chi ha nominato responsabili di società, tolto un account da una società,
  modificato l'indirizzo di contatto di una società o acceso o spento l'invio
  dei referti, e che il referto di una partita è stato inviato, con il numero
  di destinatari. Non contiene indirizzi e-mail.
- **Squadre:** il registro delle modifiche annota anche chi gestisce una
  squadra e chi ha inviato, cancellato o accettato l'elenco di una partita,
  con il numero di giocatrici, giocatori e membri dello staff e se era
  firmato, mai nomi o firme, e quando.
- **Account cancellati:** il registro delle modifiche annota che un
  amministratore ha cancellato un account o rifiutato un nuovo account, con
  i ruoli e le app dell'account, la data di creazione, il numero di partite
  ufficiali che lascia e un hash pseudonimizzato del suo indirizzo e-mail,
  mai l'indirizzo o il nome.
- **Conservazione e oscuramento:** il registro delle modifiche annota ogni
  cancellazione giornaliera dei verbali scaduti (solo la data limite e il
  numero di voci cancellate) e ogni rettifica o cancellazione dei dati di una
  persona su richiesta (solo il tipo, un hash pseudonimizzato della persona e
  il numero per tabella, mai il nome).
- **Firmare sul telefono:** il server registra solo i passaggi (avviata,
  aperta, firmata, chiusa) con la funzione e un breve identificativo, mai il
  link, la firma, nomi o squadre.

## 15. Destinatari e responsabili del trattamento

Comunico dati personali solo ai fornitori di servizi di cui ho bisogno per
l'esercizio. Essi trattano i dati per mio conto.

| Fornitore | Compito | Paese |
|---|---|---|
| Infomaniak Network SA | Hosting del server: banca dati, file, sistema di ticket e pagina di download | Svizzera |
| Cloudflare, Inc. | Distribuzione dei siti, DNS, connessione sicura al server | USA (rete mondiale) |
| Migadu | Invio di e-mail (noreply@) e casella postale (support@) | Svizzera / Europa |
| Resend, Inc. | Invio delle info della partita e del PIN della partita per e-mail (solo queste funzioni, se attivate) | USA |

**Importante riguardo a Cloudflare:** la connessione cifrata del tuo
dispositivo termina presso Cloudflare; da lì prosegue cifrata fino al mio
server. Cloudflare può quindi tecnicamente vedere il contenuto delle
richieste, comprese le liste squadra. Cloudflare può usare i
dati solo per fornire il proprio servizio.

**Sono responsabili in modo indipendente:** GitHub, Inc. (USA) per i download e
l'elenco delle versioni, F-Droid per il catalogo delle app, Swiss Volley per i
dati nel VolleyManager.

**Le copie di sicurezza** sono conservate cifrate sul mio server presso
Infomaniak e sul mio dispositivo di archiviazione, entrambi in Svizzera.
Vengono cifrate prima di lasciare il server; nessun altro può leggerle
(sezione 18).

**Comunicazione all'estero:** secondo il Consiglio federale, gli Stati
dell'UE e del SEE offrono una protezione adeguata dei dati. Per gli USA mi baso sullo
Swiss-U.S. Data Privacy Framework se il fornitore è certificato, altrimenti
sulle clausole contrattuali tipo nei contratti dei fornitori. Su richiesta
ricevi una copia di queste garanzie.

## 16. Per quanto tempo conservo i dati

| Dati | Conservazione |
|---|---|
| Account e profilo | Finché tu non cancelli l'account o un amministratore lo cancella (su richiesta, o un nuovo account rifiutato) |
| Sessione | 30 giorni dall'ultimo utilizzo, al massimo 90 giorni |
| Tentativi di accesso falliti di un indirizzo e-mail (un numero, sotto un hash dell'indirizzo) | 24 ore; cancellati prima con una nuova password o con l'account |
| Reti da cui un account è stato usato (hash con chiave, al massimo 20) | 60 giorni dopo l'ultimo uso da lì; cancellate con l'account |
| Link nelle e-mail | Validi 60 minuti o 24 ore, cancellati 7 giorni dopo |
| PIN di approvazione | Finché non lo rimuovi o non cancelli il tuo account |
| Referti, eventi delle partite, cronologia degli eventi, firme, approvazioni, osservazioni (compresi i dati sulla salute), file dei referti | Come verbale ufficiale della partita: la stagione della partita e le 2 stagioni successive (una stagione va dal 1° luglio al 30 giugno), poi cancellati da un passaggio giornaliero; per esempio i verbali della stagione 2024/25 vengono cancellati il 1° luglio 2027. Prima su richiesta nella misura in cui il verbale non necessita dei dati (sezione 19) |
| Squadre salvate, tornei di beach volley | Finché un gestore non li cancella, o su richiesta |
| Elenco degli arbitri | Finché un amministratore non cancella la voce; cancellazione su richiesta |
| Designazioni di Swiss Volley | Come i verbali delle partite: la stagione della partita e le 2 stagioni successive |
| Registro delle modifiche | Per il tempo necessario alla tracciabilità; la cancellazione su richiesta viene esaminata |
| Indirizzo di contatto di una società | Finché non viene modificato o rimosso, o la società viene cancellata |
| Responsabili di società | Finché gli amministratori non li rimuovono, la società viene cancellata o tu cancelli il tuo account |
| Responsabili di squadra | Finché un responsabile di società o un amministratore non li rimuove, la squadra o la società viene cancellata o tu cancelli il tuo account |
| Elenco inviato in anticipo (giocatrici e giocatori, staff, firme) | Finché un segnapunti non lo accetta, al più tardi 14 giorni dopo la partita; la nota dell'accettazione 14 giorni dopo la partita |
| Elenchi delle licenze di una società (numero di licenza, nomi, sesso) | Fino al prossimo caricamento di quell'elenco, alla sua cancellazione da parte di un responsabile della società o alla cancellazione della società, al più tardi fino alla fine della stagione; persone aggiunte a mano o dalla lista di una partita: fino alla cancellazione dell'elenco o della società, al più tardi fino alla fine della stagione; su un dispositivo fino al prossimo download o all'uscita dall'account |
| Indirizzo e-mail di un arbitro o di una squadra per una partita | Con la partita, come parte del referto |
| Invio del referto finale (momento, numero di destinatari, senza indirizzi) | Con la partita |
| Referto di una partita di prova per e-mail | Non conservato sul server |
| Strumento Global: backup e referto PDF di una partita (sotto il codice di backup) | 180 giorni dopo l'ultima modifica |
| Strumento Global, «Salva nel cloud»: copia leggibile di una partita, link di condivisione, codice torneo (come hash) | 180 giorni dopo l'ultimo salvataggio, o all'eliminazione dal cloud |
| Schermo live: riepilogo del punteggio di una partita il cui dispositivo segnapunti lo ha attivato (nomi delle squadre, punti, set; nessun giocatore) | Solo nella memoria del server; rimosso 45 minuti dopo la fine della partita, dopo 3 ore senza aggiornamenti o al riavvio del server |
| Copie di sicurezza caricate | 30 giorni |
| Registri dell'app caricati | 30 giorni; cancellati con il tuo account |
| Registro attività di una partita (server) | 24 mesi, al più tardi fino alla cancellazione della partita; prima su richiesta |
| Registro attività senza partita (server) | 90 giorni; le voci registrate con il tuo account vengono cancellate con esso |
| Segnalazioni di errore (server) | 90 giorni; quelle inviate con l'accesso vengono cancellate con il tuo account; prima su richiesta |
| Cronologia degli eventi (eventi annullati e corretti) | Con la partita, come parte del verbale della partita |
| Registro attività sul dispositivo | Voci caricate 180 giorni (al massimo 100 000); voci non ancora caricate fino al caricamento (al massimo 200 000); al massimo 30 file giornalieri e 50 MB |
| Registro d'uso (solo sul dispositivo) | OpenVolley dalla 2.4.0: 30 giorni, al massimo 50 000 voci |
| File di registro dell'app desktop (solo sul dispositivo) | Al massimo cinque file precedenti da 5 MB ciascuno |
| Firma sul telefono (server o portatile) | Solo nella memoria di lavoro; link valido 10 minuti, firma eliminata al più tardi 5 minuti dopo la firma |
| Richieste di supporto (casella postale e sistema di ticket, con gli allegati e i dati diagnostici) | 2 anni dopo l'ultimo messaggio; prima su richiesta |
| Registri del server | Sovrascritti in base alla dimensione, al massimo 10 file da 20 MB per servizio (alcuni giorni o poche settimane) |
| Dati in diretta (server e modalità palestra) | Solo nella memoria di lavoro; sul server eliminati 24 ore dopo l'ultima attività |
| Copie di sicurezza del server | Fino a circa 6 mesi (sezione 18) |
| Dati sul tuo dispositivo | Finché non li cancelli; copie di sicurezza delle app desktop e Android 30 giorni |

**Date di nascita cancellate (19 novembre 2026).** Da allora nessuna data di
nascita è conservata al di fuori del referto di una partita, e lì solo se il
segnapunti ne ha digitata una (sezione 7). Le date di nascita salvate prima
sono state cancellate sul server: negli account (il profilo e la copia
conservata della registrazione), negli elenchi delle licenze delle società,
nelle squadre salvate, negli elenchi inviati in anticipo, nell'elenco degli
arbitri, nelle designazioni di Swiss Volley e nei verbali delle partite
passate (liste squadra, staff, ufficiali di gara, elenchi caricati dalle
squadre, le voci e le osservazioni delle correzioni, la cronologia degli
eventi). I numeri di licenza restano. I PDF dei referti salvati vengono
rifatti a partire dai verbali corretti; un file che non può essere rifatto
così (per esempio un referto di beach volley) resta com'è finché non l'ho
verificato, e non viene cancellato senza questa verifica. Ciò che non posso
raggiungere: le e-mail già inviate (per esempio un referto finale); le copie
di sicurezza cifrate, che conservano copie più vecchie fino a circa 6 mesi
(sezione 18); e le copie al di fuori del mio server, come i dati sui
dispositivi e le copie di sicurezza su un computer, una chiavetta USB o nella
cartella «Documenti» di Android, finché non vengono sovrascritte o cancellate
(un'app di refertazione aggiornata toglie le date di nascita delle partite
svizzere sul suo dispositivo che non sono in corso). Le partite Global non
sono toccate: lì l'organizzatrice o l'organizzatore sceglie cosa figura
accanto a un nome, e i loro file e copie nel cloud restano come descritto
nella sezione 7.

## 17. Minorenni

Molte giocatrici e molti giocatori sono minorenni. I loro dati (nome, numero,
numero di licenza) non vengono inseriti da loro stessi, ma da società,
responsabili di squadra, segnapunti od organizzatori. Questi devono essere
autorizzati a registrare i dati e devono informarne le giocatrici, i
giocatori e i loro genitori. La data di nascita di una giocatrice o di un
giocatore figura solo nel referto di una partita in cui il segnapunti ne
digita una (nello strumento Global, se l'organizzatrice o l'organizzatore
l'ha scelta), mai negli elenchi delle società, nelle squadre salvate o negli
elenchi inviati in anticipo; non è mai pubblica, e nemmeno il numero di
licenza.

Nello strumento Global è responsabile allo stesso modo l'organizzatrice o
l'organizzatore del torneo, ovvero la persona che registra i dati. I genitori
possono chiedere la cancellazione del backup o della copia nel cloud di una
partita; mi servono allora
il codice di backup o i dati della partita (sezione 19).

I genitori o altri rappresentanti legali possono esercitare i diritti della
sezione 19 per il proprio figlio.

## 18. Sicurezza e copie di sicurezza

- Connessioni cifrate (HTTPS) per tutti i siti e il server.
- Password, PIN e token di accesso sono salvati sul server solo come hash.
- La banca dati e i file salvati si trovano sul server su volumi cifrati
  (LUKS2, AES). La chiave non è salvata sul server.
- Accesso secondo i ruoli; tablet solo con PIN; le partite chiuse sono in sola
  lettura.
- Limitazione dei tentativi di accesso e blocco dopo tentativi falliti.
- Copie di sicurezza: il server salva la banca dati ogni ora e i file ogni
  giorno, **in forma cifrata**. Le copie vengono trasferite ogni ora sul
  mio dispositivo di archiviazione in Svizzera e vi sono conservate in
  istantanee giornaliere, settimanali e mensili **fino a circa 6 mesi**. I dati cancellati possono
  quindi restare fino a circa 6 mesi in queste copie cifrate; servono solo per
  un ripristino.
- Le copie di sicurezza e i file di registro dell'app desktop sono leggibili
  solo dal tuo account utente e non contengono PIN.

Nessun sistema è perfettamente sicuro. Se trovi una falla di sicurezza,
segnalala a support@openvolley.app.

## 19. I tuoi diritti

Hai il diritto di:

- ottenere **informazioni** sui dati che tratto su di te;
- far **rettificare** dati inesatti;
- far **cancellare** o rendere anonimi i dati;
- **opporti** al trattamento;
- far **limitare** il trattamento, per esempio mentre si verifica una
  rettifica;
- **ricevere** i tuoi dati in un formato comune o farli trasmettere (le app
  permettono anche di scaricare copie di sicurezza, referti e il registro
  attività);
- **revocare un consenso** in ogni momento (per esempio per la ricerca di
  aggiornamenti su Android).

Scrivi a **support@openvolley.app**. Rispondo entro 30 giorni. Per non
comunicare dati alla persona sbagliata, posso chiedere una prova della tua
identità.

**Cancellazione nei referti ufficiali:** un referto chiuso è il verbale
ufficiale di una partita, a cui società, federazione e ufficiali di gara hanno
un interesse. Cancello o rendo anonimi i tuoi dati in esso nella misura in cui
il verbale non ne ha bisogno, e ti spiego cosa resta e perché. Una rettifica
(per esempio di un nome scritto male) o una cancellazione avviene in
tutte le copie sul server allo stesso tempo: nei verbali con la loro
cronologia e i loro registri, negli elenchi delle società e nelle squadre
salvate, nell'elenco degli arbitri e nelle designazioni. Il numero di maglia
e la funzione restano dove il verbale ne ha bisogno, e il PDF del referto
viene rifatto. Non posso raggiungere le copie al di fuori del mio server (sui
dispositivi, nelle e-mail già inviate). Le copie di sicurezza cifrate
conservano i vecchi dati fino a circa 6 mesi (sezione 18); se una di esse
dovesse essere ripristinata, applicherei di nuovo la tua richiesta.

**Reclamo:** puoi rivolgerti all'Incaricato federale della protezione dei dati
e della trasparenza (IFPDT, www.edoeb.admin.ch). Se risiedi nell'UE o nello
SEE, anche all'autorità di protezione dei dati del tuo paese.

## 20. Basi giuridiche (RGPD)

Se si applica il RGPD, mi baso su:

- **contratto** (art. 6 par. 1 lett. b RGPD): account (con il numero di
  licenza facoltativo), sincronizzazione,
  e-mail legate all'account, supporto, funzioni che utilizzi, il backup online e la copia nel cloud dello strumento Global;
- **interesse legittimo** (art. 6 par. 1 lett. f RGPD): verbali ufficiali
  delle partite corretti e verificabili per società, federazione e ufficiali
  di gara (liste squadra, numeri di licenza e, dove il segnapunti ne digita
  una nel referto, la data di nascita per il controllo dell'idoneità, firme,
  approvazioni, registro attività, cronologia degli eventi e osservazioni),
  squadre salvate ed elenchi delle società completati dalle liste delle
  partite ufficiali, invio del referto finale a ufficiali di gara e società, livescore per il
  pubblico, organizzazione di tornei, diagnosi dei problemi (anche le
  segnalazioni di errore delle app, che puoi disattivare),
  sicurezza e protezione dagli abusi, copie di sicurezza;
- **consenso** (art. 6 par. 1 lett. a RGPD): ricerca di aggiornamenti
  dell'app Android installata direttamente;
- **per i dati sulla salute** (un infortunio o una malattia registrati in una
  partita, sezione 7): le regole di gioco richiedono la registrazione di una
  tale sostituzione e di un libero che non può più giocare. Secondo il RGPD mi
  baso sull'art. 9 par. 2 lett. f (accertare, esercitare o difendere un
  diritto: reclami e ricorsi di una competizione si decidono sulla base del
  verbale), insieme all'interesse legittimo indicato sopra; secondo la LPD
  sull'interesse preponderante a un verbale ufficiale corretto.
  Automaticamente l'app registra solo le parole delle regole.

Secondo la LPD svizzera tratto i dati solo per gli scopi indicati e nella
misura necessaria.

**Nessun obbligo di fornire dati:** non sei obbligato né per legge né per
contratto a fornirmi dati. Senza indirizzo e-mail e password non posso però
aprire un account, e senza liste squadra non c'è referto.

## 21. Modifiche

Adeguo questa informativa quando cambiano le app o il diritto. Vale la
versione pubblicata su questa pagina, con la data indicata in alto.
