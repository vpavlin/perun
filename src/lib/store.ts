export class Store<T> {
    db:IDBDatabase | undefined = undefined
    dbName:string 
    constructor(name: string) {
        this.dbName = name
        
    }

    init = async () => {
        return new Promise((resolve, reject) => {
            const dbOpen = window.indexedDB.open(this.dbName, 1)
            dbOpen.onerror = (event) => {
                console.error(event)
                reject(new Error("Failed to open DB"))
            }
            dbOpen.onsuccess = () => {
                this.db = dbOpen.result
                console.log("setup")
                resolve(true)
            }
            dbOpen.onupgradeneeded = (event:IDBVersionChangeEvent) => {
                // @ts-ignore
                const db:IDBDatabase = event.target.result

                

                db.onerror = (e:any) => {
                    console.error(e)
                    reject(new Error("Failed to upgrade the DB"))
                }

                const objectStore = db.createObjectStore("entry", { keyPath: "hash" });

                objectStore.createIndex("run", "runId", { unique: false})
                objectStore.createIndex("roughLocation", "geoHash", { unique: false})

                resolve(true)
            }
        })
    }

    set = async (msg:T) => {
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(["entry"], "readwrite");
            const objectStore = transaction.objectStore("entry");
            const request = objectStore.add(msg)
            request.onerror = (evt) => {
                console.error(evt)
                //@ts-ignore
                reject("Error while entering into db: "+ evt.target!.error)
            }
            request.onsuccess = (evt) => {
                resolve(undefined)
            }
        })
    }

    update = (msg:T) => {
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(["entry"], "readwrite");
            const objectStore = transaction.objectStore("entry");
            const request = objectStore.put(msg)
            request.onerror = (evt) => {
                console.error(evt)
                reject()
            }
            request.onsuccess = (evt) => {
                resolve(undefined)
            }
        })
    }

    get = async (hash:string) => {
        return new Promise<T>((resolve, reject) => {
            const transaction = this.db!.transaction(["entry"], "readwrite");
            const objectStore = transaction.objectStore("entry");
            const request = objectStore.get(hash)
            request.onerror = (evt) => {
                console.error(evt)
                reject("Failed to query the DB")
            }
            request.onsuccess = () => {
                const data: T = request.result
                resolve(data)
            }
        })
    }

    getAll = async (runId?: string) => {
        return new Promise<T[]>((resolve, reject) => {
            const transaction = this.db!.transaction(["entry"]);
            const objectStore = transaction.objectStore("entry");
            if (runId) {
                const index = objectStore.index("run")
                const keyRng = IDBKeyRange.only(runId);

                const cursorRequest = index.openCursor(keyRng);
                const data:T[] = []
            
                cursorRequest.onsuccess = (e) => {
                    //@ts-ignore
                    const cursor = e.target?.result;
                    if (cursor) {
                        data.push(cursor.value)
                        cursor.continue()
                    } else {
                        console.log(data)
                        resolve(data)
                    }
                }
            } else {
                const request = objectStore.getAll(runId)
            
                request.onerror = (evt) => {
                    console.error(evt)
                    reject("Failed to query the DB")
                }
                request.onsuccess = () => {
                    const data: T[] = request.result
                    resolve(data)
                }
            }
        })

    }




}