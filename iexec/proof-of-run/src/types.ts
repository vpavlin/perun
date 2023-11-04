export type GeoLocation = {
    lat: number,
    lon: number,
    speed: number | null,
    heading: number | null,
    geoHash: string
    timestamp: number
}

export type ProtectedData = {
    data: SyncData
}


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