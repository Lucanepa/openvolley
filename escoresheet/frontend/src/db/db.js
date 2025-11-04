import Dexie from 'dexie'

export const db = new Dexie('escoresheet')

db.version(1).stores({
  teams: '++id,name,createdAt',
  players: '++id,teamId,number,name,role,createdAt',
  matches: '++id,homeTeamId,awayTeamId,scheduledAt,status,createdAt',
  sets: '++id,matchId,index,homePoints,awayPoints,finished',
  events: '++id,matchId,setIndex,ts,type,payload',
  sync_queue: '++id,resource,action,payload,ts,status' // status: queued|sent|error
})


