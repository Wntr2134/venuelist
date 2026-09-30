# Riderly Guest List: API v1 (for the Riderly venue manager)

Base URL: `https://guestlist.riderly.com.au/api/v1`

**Auth:** each venue makes its own key in its venue admin page (`/v/<username>/admin` → Riderly venue manager → Connect to Riderly). Send it on every request:

```
Authorization: Bearer rgl_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

- One key per venue. It only reaches that venue's shows.
- Keys are shown once. Making a new key or pressing Disconnect kills the old one straight away.
- Call **server-to-server only**. Never put a key in browser JavaScript. Store keys encrypted or in secrets, never in git or logs.
- Bad keys get `401 {"error":"Invalid API key"}`. Too many bad keys from one IP address get `429`.
- The API **never returns guest names or notes**. You get totals only.

## Endpoints

### `GET /venue`
Tests a key. Returns `{ name, username, links: { staffLogin, venueAdmin, app, guide } }`.

### `PUT /events/ext:<externalId>` (create or update a show)
`externalId` is **your** show ID (1–100 characters: letters, numbers, `_ . : -`). The first call creates the show; later calls update it. Only the fields you send change.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required when creating |
| `date` | `YYYY-MM-DD` | Required when creating |
| `doorsTime` | `HH:MM` or null | |
| `venueCapacity` | int or null | Door clicker capacity. Default: the venue's default |
| `guestListCap` | int or null | Max guest list heads |
| `notes` | string | Staff can see these |
| `ticketsSold` | int or null | e.g. from Moshtix |
| `ticketsScanned` | int or null | e.g. from Moshtix after the night |
| `archived` | bool | |

Returns `{ created: true|false, event }`.

### `GET /events?from=YYYY-MM-DD&to=YYYY-MM-DD[&archived=1]`
Returns `{ events: [event…] }`, at most 500, sorted by date.

### `GET /events/<id>` or `GET /events/ext:<externalId>`
Returns one `event`.

### `GET /events/<id or ext:…>/report`
Night report totals: `{ event, door, tickets, guestlist, byContributor[], byList[], firstIn, overrideCount }`. `byContributor` includes contributor names (e.g. the artist or promoter) and their numbers.

### `DELETE /events/<id or ext:…>`
Cancelled show. If nobody is on the list yet, it's deleted and you get `{deleted:true}`. Otherwise it's archived, so no names are lost, and you get `{archived:true}`.

## The `event` object

```json
{
  "id": 12, "externalId": "show-123", "name": "Friday", "date": "2026-10-02", "doorsTime": "19:30",
  "capacity": 40, "venueCapacity": 300, "archived": false, "countGuestlist": false,
  "ticketsSold": 180, "ticketsScanned": 141,
  "door": { "count": 12, "capacity": 300, "peak": 290, "totalIn": 350, "totalOut": 338 },
  "guestlist": { "entries": 20, "heads": 38, "arrived": 30, "inside": 2, "noShow": 8, "vip": 3 },
  "tickets": { "sold": 180, "scanned": 141, "noShow": 39, "expectedIn": 171, "doorIn": 350, "difference": 179 },
  "links": { "app": "https://guestlist.riderly.com.au/app#/event/12", "report": "…/report" }
}
```

`tickets.expectedIn` = scanned tickets + guest list arrivals. `difference` = door clicker total in − expectedIn. Re-entries make it run a little positive. It's `null` until tickets are scanned and the clicker has been used.

Errors are always `{ "error": "message" }` with a 4xx or 5xx status.
