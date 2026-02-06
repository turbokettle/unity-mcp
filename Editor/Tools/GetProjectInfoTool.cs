using System;
using UnityEngine;
using UnityEditor;

namespace UnityMCP.Tools
{
    /// <summary>
    /// Response data for the get_project_info tool.
    /// </summary>
    [Serializable]
    public class ProjectInfoResponse
    {
        public string projectName;
        public string unityVersion;
        public string projectPath;
        public string companyName;
        public string productName;
        public string currentScene;
        public bool isPlaying;
        public bool isPaused;
    }

    /// <summary>
    /// Tool for getting Unity project information.
    /// </summary>
    public class GetProjectInfoTool : IMcpTool
    {
        public string Name => "get_project_info";

        public string Description => "Get information about the current Unity project, including version, paths, and play mode state.";

        public bool RequiresMainThread => true; // EditorApplication APIs need main thread

        public ToolParameterSchema GetParameterSchema()
        {
            // No parameters needed
            return SchemaBuilder.Empty();
        }

        public MCPResponse Execute(string id, string paramsJson)
        {
            var info = new ProjectInfoResponse
            {
                projectName = Application.productName,
                unityVersion = Application.unityVersion,
                projectPath = Application.dataPath.Replace("/Assets", ""),
                companyName = Application.companyName,
                productName = PlayerSettings.productName,
                currentScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,
                isPlaying = EditorApplication.isPlaying,
                isPaused = EditorApplication.isPaused
            };

            return MCPResponse.Success(id, info);
        }
    }
}
