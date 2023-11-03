import { useState } from "react";
import { RUN_STORAGE } from "../../constants";
import { useStore } from "../../hooks/useStore";
import { RunItem } from "../../lib/types";
import { sha256 } from "js-sha256";
import { useNavigate } from "react-router-dom";

const NewRun = () => {
    const storeRuns = useStore<RunItem>(RUN_STORAGE)
    const [name, setName] = useState<string>()
    const navigate = useNavigate()

    const create = async () => {
        if (!storeRuns || !name) return
        const hash = sha256(name).slice(0, 8)
        await storeRuns.set({
            hash: hash,
            name: name,
            startTimestamp: undefined,
            finishTimestamp: undefined,
        })
        navigate("/run/"+hash)
    }

    return (<>
        <div className="max-w-md text-center items-center m-auto">
            <label className="label">
                <span className="label-text">Run Name</span>
                <input type="text" className="input input-primary" onChange={(e) => setName(e.target.value)} />
            </label>
            <button className="btn btn-lg btn-primary" disabled={!name || !storeRuns} onClick={create}>Create</button>
        </div>
    </>)
}

export default NewRun;