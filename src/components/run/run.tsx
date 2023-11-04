import { useParams } from "react-router-dom";
import Map from "./map";
import Panel from "./panel";
import NewRun from "./new";

const Run = () => {
    const {id} = useParams()

    return (
        <>
            <div className="relative min-h-[800px] h-full">
                <Map  id={id} />
                { id ?
                    <Panel id={id} />
                    :
                    <NewRun />
                }

            </div>
        </>
    )
}

export default Run;