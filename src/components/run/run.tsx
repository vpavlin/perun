import { useParams } from "react-router-dom";
import Map from "./map";
import Panel from "./panel";
import NewRun from "./new";

const Run = () => {
    const {id} = useParams()

    return (
        <>
            <div className="relative h-full overflow-hidden">
                
                { id ?
                    <div>
                        <Map id={id} />
                        <Panel id={id} />
                    </div>
                    :
                    <NewRun />
                }

            </div>
        </>
    )
}

export default Run;