// How to enter the special steps of the Diktat in OpenVolley (app.openvolley.app/dictate).
// The screenshots are from a full replay of the dictation through a test match
// (English app, 1280×800), on R2: openvolley-media/dictate/howto/<id>.jpg.
// `steps`: where the step occurs in the dictation (a tap jumps the video there);
// `exc`: only in the version with exceptional substitutions.

export const HOWTO = [
  {
    id: 'improper',
    steps: ['148', '149', '502', '503'],
    shots: ['improper-2'],
    en: {
      title: 'Third time-out request → improper request',
      do: ['The team has used both time-outs of the set: its TO box no longer reacts, a third time-out cannot be entered.', 'Tap the team\'s "Improper request" button (under its TO and SUB boxes) and confirm.', 'The team\'s improper request is crossed on the sheet; a second one in the match would be a delay.']
    },
    de: {
      title: 'Dritte Timeout-Anfrage → unzulässige Anfrage',
      do: ['Das Team hat beide Timeouts des Satzes gebraucht: sein TO-Feld reagiert nicht mehr, ein drittes Timeout kann nicht erfasst werden.', 'Tippe auf den Knopf «Improper request» des Teams (unter seinen TO- und SUB-Feldern) und bestätige.', 'Die unzulässige Anfrage des Teams wird auf dem Matchblatt angekreuzt; eine zweite im Spiel wäre eine Verzögerung.']
    }
  },
  {
    id: 'replay',
    steps: ['284'],
    shots: ['replay-1', 'replay-2'],
    en: {
      title: 'The 1st referee revises the decision: replay',
      do: ['Tap "Decision change" under the court.', 'Choose "Replay the rally" (not "Assign to other team").', 'Confirm. The last point is taken back and the same team serves again.']
    },
    de: {
      title: 'Der 1. Schiedsrichter korrigiert: Ballwechsel wiederholen',
      do: ['Tippe unter dem Feld auf «Decision change».', 'Wähle «Replay the rally» (nicht «Assign to other team»).', 'Bestätige. Der letzte Punkt fällt weg, das gleiche Team schlägt wieder auf.']
    }
  },
  {
    id: 'coach',
    steps: ['285'],
    shots: ['coach-1'],
    en: {
      title: 'Warning for the coach',
      do: ['Tap the coach (C) in the team\'s bench officials list.', 'Choose "Warning" and confirm.']
    },
    de: {
      title: 'Verwarnung für den Trainer',
      do: ['Tippe in der Liste der Bankoffiziellen des Teams auf den Trainer (C).', 'Wähle «Warning» und bestätige.']
    }
  },
  {
    id: 'sanction',
    steps: ['359', '474', '655', '656'],
    shots: ['sanction-1'],
    en: {
      title: 'Warning or penalty for a player',
      do: ['Tap the player on court (a player on the bench: tap the number in the bench list).', 'Choose "Sanction", then "Warning" or "Penalty", and confirm.', 'A penalty gives the point (and the serve) to the other team.']
    },
    de: {
      title: 'Verwarnung oder Strafe für einen Spieler',
      do: ['Tippe auf den Spieler auf dem Feld (auf der Bank: auf die Nummer in der Bankliste).', 'Wähle «Sanction», dann «Warning» oder «Penalty», und bestätige.', 'Eine Strafe gibt dem anderen Team den Punkt (und den Aufschlag).']
    }
  },
  {
    id: 'delay',
    steps: ['464', '473'],
    shots: ['delay-1', 'delay-2'],
    en: {
      title: 'Delay warning and delay penalty',
      do: ['Tap "Delay warning" under the team\'s TO and SUB boxes and confirm with "Yes".', 'After a delay warning the same button reads "Delay penalty": the next delay is a penalty, a point for the other team.']
    },
    de: {
      title: 'Verzögerungswarnung und Verzögerungsstrafe',
      do: ['Tippe unter den TO- und SUB-Feldern des Teams auf «Delay warning» und bestätige mit «Yes».', 'Nach einer Verzögerungswarnung heisst der gleiche Knopf «Delay penalty»: die nächste Verzögerung ist eine Strafe, ein Punkt für das andere Team.']
    }
  },
  {
    id: 'expulsion',
    steps: ['476', '477', '657', '658'],
    shots: ['expulsion-1', 'expulsion-2'],
    en: {
      title: 'Expulsion or disqualification, then the substitution',
      do: ['Tap the player, choose "Sanction", then "Expulsion" or "Disqualification", and confirm.', 'A player on court must be replaced: OpenVolley asks for the substitution itself. With only one legal substitute it proposes him (here #9): confirm.']
    },
    de: {
      title: 'Ausschluss oder Disqualifikation, dann die Auswechslung',
      do: ['Tippe auf den Spieler, wähle «Sanction», dann «Expulsion» oder «Disqualification», und bestätige.', 'Ein Spieler auf dem Feld muss ersetzt werden: OpenVolley fragt selbst nach der Auswechslung. Gibt es nur einen regulären Ersatz, schlägt es ihn vor (hier #9): bestätige.']
    }
  },
  {
    id: 'libero',
    steps: ['337', '338', '633', '634', '635'],
    shots: ['libero-1', 'libero-2', 'libero-3'],
    en: {
      title: 'Libero unable to play, re-designation',
      do: ['Tap the libero, on court or in the LIBEROS list, and choose "Unable to play".', 'Choose "Declared unable" (the coach or game captain declares it) or "Injury / illness", and confirm.', 'If the team has no libero left, answer "Yes, redesignate" (or "No, later" while the other libero can still play) and pick the new libero (here #5). The remark is written for you.']
    },
    de: {
      title: 'Libero spielunfähig, Neubezeichnung',
      do: ['Tippe auf den Libero, auf dem Feld oder in der Liste LIBEROS, und wähle «Unable to play».', 'Wähle «Declared unable» (Trainer oder Spielkapitän erklären es) oder «Injury / illness» und bestätige.', 'Hat das Team keinen Libero mehr, antworte «Yes, redesignate» (oder «No, later», solange der andere Libero noch spielen kann) und wähle den neuen Libero (hier #5). Die Bemerkung schreibt OpenVolley selbst.']
    }
  },
  {
    id: 'set5',
    steps: ['600'],
    shots: ['set5-1'],
    en: {
      title: 'Set 5: new coin toss',
      do: ['Before set 5 OpenVolley shows the set 5 setup.', 'LUZERN must be on the right and serve first: use "Switch sides" and "Switch serve" until it is so.', 'Tap "Confirm set 5 setup". At 8 points the teams change sides by themselves.']
    },
    de: {
      title: 'Satz 5: neue Auslosung',
      do: ['Vor Satz 5 zeigt OpenVolley die Einstellung für Satz 5.', 'LUZERN muss rechts sein und den ersten Aufschlag haben: mit «Switch sides» und «Switch serve» einstellen.', 'Tippe auf «Confirm set 5 setup». Bei 8 Punkten wechseln die Teams die Seiten von selbst.']
    }
  },
  {
    id: 'captain',
    steps: ['123', '242', '279', '301', '354', '452', '498', '614', '652'],
    shots: ['captain-1'],
    en: {
      title: 'Game captain',
      do: ['When the team captain leaves the court, OpenVolley asks for the game captain.', 'Tap the number the dictation names (for example #8). If OpenVolley does not ask, there is nothing to enter.']
    },
    de: {
      title: 'Spielkapitän',
      do: ['Verlässt der Teamkapitän das Feld, fragt OpenVolley nach dem Spielkapitän.', 'Tippe auf die Nummer aus dem Diktat (zum Beispiel #8). Fragt OpenVolley nicht, ist nichts einzutragen.']
    }
  },
  {
    id: 'exc',
    exc: true,
    steps: ['661a', '661b'],
    shots: ['exc-1', 'exc-2', 'exc-3'],
    en: {
      title: 'Exceptional substitution after an injury',
      do: ['Tap the injured player on court (#9) and choose "Injury".', 'No legal substitution is possible: OpenVolley shows "No legal substitution available". Choose "Exceptional substitution".', 'Pick the player who comes in (#4) and confirm. It does not count toward the 6; #9 cannot play again in this match.']
    },
    de: {
      title: 'Ausserordentliche Auswechslung nach einer Verletzung',
      do: ['Tippe auf den verletzten Spieler auf dem Feld (#9) und wähle «Injury».', 'Kein regulärer Wechsel ist möglich: OpenVolley zeigt «No legal substitution available». Wähle «Exceptional substitution».', 'Wähle den Spieler, der reinkommt (#4), und bestätige. Sie zählt nicht zu den 6; #9 darf im Spiel nicht mehr spielen.']
    }
  },
  {
    id: 'excs',
    exc: true,
    steps: ['664a', '664b', '664c', '666a', '666b'],
    shots: ['excs-1', 'excs-2'],
    en: {
      title: 'Exceptional substitution after an expulsion or a disqualification',
      do: ['Enter the expulsion (ZÜRICH #1) or the disqualification (LUZERN #4) as usual and confirm.', 'With no legal substitute left, "No legal substitution available" opens by itself: choose "Exceptional substitution", pick the player (#10, #2) and confirm.', 'When the team captain is the one who leaves, OpenVolley then asks for the game captain (#2).']
    },
    de: {
      title: 'Ausserordentliche Auswechslung nach Ausschluss oder Disqualifikation',
      do: ['Erfasse den Ausschluss (ZÜRICH #1) oder die Disqualifikation (LUZERN #4) wie gewohnt und bestätige.', 'Ohne regulären Ersatz öffnet sich «No legal substitution available» von selbst: wähle «Exceptional substitution», dann den Spieler (#10, #2), und bestätige.', 'Ist es der Teamkapitän, der raus muss, fragt OpenVolley danach nach dem Spielkapitän (#2).']
    }
  }
]
