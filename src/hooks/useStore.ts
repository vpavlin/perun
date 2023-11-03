import { useEffect, useMemo, useRef, useState } from "react"
import { Store } from "../lib/store"

export const useStore = <T>(name: string) => {
    const [store, setStore] = useState<Store<T>>()
    const inited = useRef(false)

    useEffect(() => {
        if (inited.current) return
        inited.current = true;

        (async () => {
            const s = new Store<T>(name)
            console.log("here");

            await s.init()
            console.log("done")
            setStore(s)
        })()
    }, [])

    return useMemo(() => (
        store
    ), [
        store
    ])
}