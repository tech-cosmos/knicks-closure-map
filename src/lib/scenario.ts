import type { FeedEvent } from "./types";

/**
 * Scripted "Knicks win" night for the replay demo. t = minutes after the final buzzer
 * (~10:30 PM). Official, social and crowd reports are mixed on purpose: some
 * corroborate each other, one is a rumor, and one closure later reopens.
 */
export const BUZZER_LABEL = "10:30 PM";

export const SCENARIO: FeedEvent[] = [
  { id: "e01", t: 1, source: "official", author: "NYPD Midtown South",
    text: "Expect heavy pedestrian traffic around Madison Square Garden after tonight's game. 7th Ave between W 31st St and W 34th St is closed to vehicles." },
  { id: "e02", t: 3, source: "social", author: "@bxknicksfan",
    text: "LMAOOO 8th ave is PACKED, cops just shut it between 31st and 34th 🧡💙 #Knicks #NewYorkForever" },
  { id: "e03", t: 5, source: "social", author: "@hellskitchenhank",
    text: "Knicks fans flooding 33rd St between 7th and 8th, nobody is moving, cars are stuck" },
  { id: "e04", t: 6, source: "report", author: "App user near Penn",
    text: "33rd st blocked with barricades between 7th & 8th ave" },
  { id: "e05", t: 8, source: "social", author: "@nyc_rumor_mill",
    text: "heard they're closing all of Times Square?? 🔥🔥" },
  { id: "e06", t: 10, source: "social", author: "@timessqcam",
    text: "Times Sq absolutely mobbed. 7th Ave between 42nd and 47th, no cars getting through at all" },
  { id: "e07", t: 12, source: "official", author: "NYC DOT",
    text: "TRAFFIC ADVISORY: Broadway between W 42nd St and W 47th St and 7th Ave between W 42nd St and W 47th St are closed to vehicular traffic until further notice." },
  { id: "e08", t: 14, source: "social", author: "@midtowncommuter",
    text: "34th st between 6th and 7th is a parking lot rn, crowd standing in the street, honking everywhere" },
  { id: "e09", t: 15, source: "report", author: "App user at Herald Sq",
    text: "34th St between 6th Ave and 7th Ave — fans in the roadway, cars turned around" },
  { id: "e10", t: 17, source: "official", author: "MTA NYC Transit",
    text: "34 St-Penn Station: entrances at 7th Ave & W 32nd St are closed due to crowding. Use 8th Ave entrances." },
  { id: "e11", t: 19, source: "social", author: "@anon8812",
    text: "someone said 6th ave is closed from 40th to 44th? can anyone confirm" },
  { id: "e12", t: 22, source: "report", author: "App user on 8th Ave",
    text: "8th Ave between 31st and 34th still blocked, police cars across the avenue" },
  { id: "e13", t: 26, source: "official", author: "NYPD Midtown South",
    text: "UPDATE: 7th Ave between W 31st St and W 34th St has reopened to vehicle traffic." },
  { id: "e14", t: 30, source: "official", author: "Office of the Mayor",
    text: "Knicks victory parade Thursday: Broadway from Battery Pl to Chambers St (Canyon of Heroes) will be closed to all traffic starting 6 AM." },
];
