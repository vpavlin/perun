import { GeoLocation } from "../hooks/useLocation"

export type StoreItem = {
    loc: GeoLocation
    geoHash: string
    hash: string
    runId: string
}

export type RunItem = {
    hash: string
    name: string
    startTimestamp: number | undefined
    finishTimestamp: number | undefined
}

export type PairingRequest = {
    publicKey: string
    deviceName: string
    secret: string
    confirmed: boolean
}

export type SyncData = {
    run: RunItem
    points: StoreItem[]

}